'use strict';

const debug = require('debug')('app:tweetHandler');
const fs = require('fs');
const Entities = require('html-entities').AllHtmlEntities;
const fetch = require('node-fetch');
const utils = require('./utils');
const discordClient = require('./discordClient');
const TweetsModel = require('./models/tweets');

debug('Loading tweetHandler.js');

const htmlEntities = new Entities();
const recentTweets = [];

// Process tweets
module.exports = (tweet, manual) => {
  // Handle tweet deletions first
  // The JSON structure is completely different on a deletion
  if (tweet.delete) {
    debug(tweet);
    debug(`TWEET: ${tweet.delete.status.id_str}: DELETED`);
    deleteTweet(tweet);
    return;
  }

  debug(`TWEET: ${tweet.id_str}: https://twitter.com/${tweet.user.screen_name}/status/${tweet.id_str}`);

  // Exit if tweet is not authored by a registered user we are currently streaming
  // This covers most re-tweets and replies unless from  another registered user
  if (!utils.ids.includes(tweet.user.id_str)) {
    debug(`TWEET: ${tweet.id_str}: Authored by an unregistered user. Exiting.`);
    return;
  }

  // Ensure no duplicate tweets get posted
  // Keeps last 20 tweet ids in memory
  // Manual posts bypass this check
  if (!manual) {
    if (recentTweets.includes(tweet.id_str)) {
      debug(`TWEET: ${tweet.id_str}: Was recently processed. Duplicate? Exiting.`);
      return;
    }
    recentTweets.push(tweet.id_str);
    if (recentTweets.length > 20) {
      recentTweets.shift();
    }
  }

  // Store the tweet for reference / tests
  // These are flushed after a months time daily
  fs.writeFileSync(`./tweets/${tweet.user.screen_name}-${tweet.id_str}${manual ? '-man' : ''}.json`,
    JSON.stringify(tweet, null, 2), { encoding: 'utf8' });

  // Exit if tweet is a reply not from the same user. ie in a thread
  if (tweet.in_reply_to_user_id_str && tweet.in_reply_to_user_id_str !== tweet.user.id_str) {
    debug(`TWEET: ${tweet.id_str}: Non-self reply. Exiting.`);
    return;
  }

  // Get the proper tweet context
  // The tweet or the re-tweeted tweet if it exists
  const context = tweet.retweeted_status || tweet;
  let text;
  let extendedEntities;
  // Use the extended tweet data if the tweet was truncated. ie over 140 chars
  if (tweet.truncated) {
    text = context.extended_tweet.full_text;
    extendedEntities = context.extended_tweet.extended_entities;
  } else {
    text = context.text; // eslint-disable-line prefer-destructuring
    extendedEntities = context.extended_entities;
  }
  // Decode html entities in the twitter text string so they appear correctly (&amp)
  let modifiedText = htmlEntities.decode(text);
  debug(modifiedText);
  debug(extendedEntities);

  // Array to hold picture and gif urls we will extract from extended_entities
  const mediaUrls = [];
  // Array of urls we have escaped to avoid escaping more than once
  const escapedUrls = [];

  if (extendedEntities) {
    // Extract photos
    extendedEntities.media.filter(media => media.type === 'photo')
      .forEach(media => {
        // Add image to media list
        mediaUrls.push({ image: media.media_url_https });
        // Escape the media url so it does not auto-embed in discord
        // Wrapped in <>
        // Only escape once
        if (!escapedUrls.includes(media.url)) {
          escapedUrls.push(media.url);
          modifiedText = modifiedText.replace(media.url, `<${media.url}>`);
        }
      });

    // Extract gifs
    extendedEntities.media.filter(media => media.type === 'animated_gif')
      .forEach(media => {
        // Get the mp4 data object
        const video = media.video_info.variants[0].url;
        // Use the media image as backup if conversion fails
        const image = media.media_url_https;
        // Add media data to list
        mediaUrls.push({ video, image });
        // Escape the media url so it does not auto-embed in discord
        // Wrapped in <>
        // Only escape once
        if (!escapedUrls.includes(media.url)) {
          escapedUrls.push(media.url);
          modifiedText = modifiedText.replace(media.url, `<${media.url}>`);
        }
      });
  }
  debug('mediaUrls', mediaUrls);

  // Trim any whitespace left from replacing strings in the modifiedText string
  modifiedText = modifiedText.trim();

  // Create a new string to send to Discord
  let str = `\`\`\`qml\nNew Tweet from ${tweet.user.screen_name}:\`\`\``
    + `<https://twitter.com/${tweet.user.screen_name}/status/${tweet.id_str}>\n`;
  if (modifiedText) {
    let nameRT;
    if (tweet.retweeted_status) nameRT = tweet.retweeted_status.user.screen_name;
    str += `\n${nameRT ? `RT @${nameRT}: ` : ''}${modifiedText}\n`;
  }
  debug(str);

  // Process the media entries
  utils.promiseSome(mediaUrls.map(media => processMediaEntry(media, tweet.id_str)))
    .then(() => {
      // Send to the Discord Client
      discordClient.send(tweet, str);
    })
    .catch(err => {
      console.error(err);
      // Send the string to the Discord Client regardless that the media promise failed
      // This should not occur if a single media element fails but due to a greater internal concern
      // as promiseSome does not reject on a single promise rejection unlike Promise.All
      discordClient.send(tweet, str);
    });
};

function processMediaEntry(media, id) {
  return new Promise((resolve, reject) => {
    resolve();
  });
}

function deleteTweet(tweet) {
  if (!tweet || !tweet.delete || !tweet.delete.status) return;
  debug(`TWEET: ${tweet.delete.status.id_str}: Processing deletion...`);
  // Find a matching record for the tweet id
  TweetsModel.findOne({ tweet_id: tweet.delete.status.id_str })
    .then(result => {
      debug(result);
      // Exit if no match or the messages property does not exist for some reason
      if (!result || !result.messages) return;
      result.messages
        .forEach(msg => {
          // Send a DELETE request to Discord api directly for each message we want to delete
          const uri = `https://discordapp.com/api/channels/${msg.channel_id}/messages/${msg.message_id}`;
          debug(uri);
          fetch(uri, {
            method: 'DELETE',
            headers: {
              Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`,
            },
          })
            .then(() => {
              debug('Twitter message deleted OK');
            })
            .catch(console.error);
        });
    })
    .catch(console.error);
}
