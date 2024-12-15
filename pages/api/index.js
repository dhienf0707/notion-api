import Cors from 'cors';
import { BlobServiceClient } from '@azure/storage-blob';
const redisClient = require('./redis');
const { Client } = require('@notionhq/client');
require('dotenv').config();
import { NotionAPI } from 'notion-client'


// Initializing the cors middleware
const cors = Cors({
  methods: ['GET', 'HEAD'],
});

// Initialize Notion client
const notion = new Client({
  auth: process.env.NOTION_TOKEN,
});

const notionAPI = new NotionAPI({
  activeUser: process.env.NOTION_ACTIVE_USER,
  authToken: process.env.NOTION_AUTH_TOKEN,
});

// Initialize Azure Blob Storage client
const blobServiceClient = BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING);

// Create the container if it doesn't exist
const containerName = 'notion-cache';
const containerClient = blobServiceClient.getContainerClient(containerName);
containerClient.createIfNotExists().then(() => {
  console.log(`Container ${containerName} created or already exists.`);
}).catch((err) => {
  console.error(`Error creating container ${containerName}:`, err);
});

// Helper method to wait for a middleware to execute before continuing
// And to get response data in the correct format
function runMiddleware(req, res, fn) {
  return new Promise((resolve, reject) => {
    fn(req, res, (result) => {
      if (result instanceof Error) {
        return reject(result);
      }

      return resolve(result);
    });
  });
}

// Helper function to get data from Redis or Azure Blob Storage
async function getCachedData(cacheKey) {
  try {
    // Check if the data is cached in Redis
    const cachedData = await redisClient.get(cacheKey);
    if (cachedData) {
      console.log('Data retrieved from Redis');
      return JSON.parse(cachedData);
    }

    // If not in Redis, check Azure Blob Storage
    const containerClient = blobServiceClient.getContainerClient(containerName);
    const blobClient = containerClient.getBlobClient(`${cacheKey}.json`);
    const downloadResponse = await blobClient.download();
    const downloadedData = (await streamToBuffer(downloadResponse.readableStreamBody)).toString();

    // Cache the data in Redis for future requests
    await redisClient.set(cacheKey, downloadedData, 'EX', 3600); // Cache for 1 hour

    console.log('Data retrieved from Azure Blob Storage');
    return JSON.parse(downloadedData);
  } catch (error) {
    console.error(`Error retrieving cached data for ${cacheKey}:`, error);
    return null;
  }
}

// Helper function to convert a stream to a buffer
function streamToBuffer(readableStream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    readableStream.on('data', (data) => {
      chunks.push(data instanceof Buffer ? data : Buffer.from(data));
    });
    readableStream.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    readableStream.on('error', reject);
  });
}

async function fetchPostFromNotion(slug) {
  const database = await notion.databases.query({
    database_id: process.env.NOTION_DATABASE_ID,
    filter: {
      property: "Slug",
      rich_text: {
        equals: slug
      }
    }
  });
  const page = database.results[0];
  const recordMap = await notionAPI.getPage(page.id);

  return {
    page,
    recordMap: recordMap,
  };
}

async function fetchPostsFromNotion() {
  const response = await notion.databases.query({
    database_id: process.env.NOTION_DATABASE_ID,
    sorts: [
      {
        property: 'Date',
        direction: 'descending',
      },
    ],
  });

  const posts = response.results.map(page => ({
    id: page.id,
    title: page.properties.Name.title[0]?.plain_text || '',
    date: page.last_edited_time || '',
    description: page.properties.Description?.rich_text[0]?.plain_text || '',
    slug: page.properties.Slug?.rich_text[0]?.plain_text || '',
    cover_img: page.properties.cover?.rich_text[0]?.plain_text || '',
  }));

  return posts;
}

// Helper function to cache data in Redis and Azure Blob Storage
async function cacheData(cacheKey, data) {
  try {
    // Cache data in Redis
    await redisClient.set(cacheKey, JSON.stringify(data), 'EX', 3600); // Cache for 1 hour

    // Cache data in Azure Blob Storage
    const containerClient = blobServiceClient.getContainerClient(containerName);
    const blobClient = containerClient.getBlockBlobClient(`${cacheKey}.json`);
    await blobClient.upload(Buffer.from(JSON.stringify(data)), Buffer.byteLength(JSON.stringify(data)));
  } catch (error) {
    console.error(`Error caching data for ${cacheKey}:`, error);
  }
}

export default async function handler(req, res) {
  await runMiddleware(req, res, cors);

  if (req.method === 'GET') {
    if (req.query.slug) {
      // Get single blog post
      try {
        const { slug } = req.query;
        const cacheKey = `post:${slug}`;

        // Get cached post data
        const cachedPost = await getCachedData(cacheKey);
        if (cachedPost) {
          return res.status(200).json(cachedPost);
        }

        // Fetch post from Notion and cache it
        const response = await fetchPostFromNotion(slug);
        await cacheData(cacheKey, response);
        return res.status(200).json(response);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    } else {
      // Get all blog posts
      try {
        const cacheKey = 'posts';

        // Get cached posts data
        const cachedPosts = await getCachedData(cacheKey);
        if (cachedPosts) {
          return res.status(200).json(cachedPosts);
        }

        // Fetch posts from Notion and cache them
        const posts = await fetchPostsFromNotion();
        await cacheData(cacheKey, posts);
        return res.status(200).json(posts);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    }
  } else {
    res.status(405).json({ error: 'Method not allowed' });
  }
}