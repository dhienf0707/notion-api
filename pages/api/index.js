import Cors from 'cors';

// Initializing the cors middleware
const cors = Cors({
  methods: ['GET', 'HEAD'],
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

// pages/api/posts.js
const { Client } = require('@notionhq/client');
require('dotenv').config();

const notion = new Client({
  auth: process.env.NOTION_TOKEN,
});

export default async function handler(req, res) {
  // Run the middleware
  await runMiddleware(req, res, cors);

  if (req.method === 'GET') {
    if (req.query.slug) {
      // Get single blog post
      try {
        const { slug } = req.query;
        const page = await notion.pages.retrieve({ page_id: slug });
        const blocks = await notion.blocks.children.list({ block_id: page.id });

        res.status(200).json({
          page,
          blocks: blocks.results,
        });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    } else {
      // Get all blog posts
      try {
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
          slug: page.properties.Slug?.rich_text[0]?.plain_text || page.id,
          cover_img: page.properties['Featured Image']?.files[0]?.file.url || '',
        }));

        res.status(200).json(posts);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    }
  } else {
    res.status(405).json({ error: 'Method not allowed' });
  }
}