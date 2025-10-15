// server.js
import express from 'express';
import fetch from 'node-fetch';
import cors from 'cors';
import crypto from 'crypto';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const SHOP = process.env.SHOPIFY_SHOP;
const API_VERSION = '2025-10';
const ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

// ---- Helper to fetch paginated metaobjects ----
async function fetchAllCOAs() {
  if (!ACCESS_TOKEN) {
    throw new Error('SHOPIFY_ACCESS_TOKEN not set in .env');
  }

  const allCOAs = [];
  let after = null;

  do {
    const query = `
      query {
        metaobjects(type: "certificates_of_analysis", first: 50${after ? `, after: "${after}"` : ''}, sortKey: "updated_at", reverse: true) {
          edges {
            node {
              id
              date: field(key: "date") { value }
              product_name: field(key: "product_name") { value }
              batch_number: field(key: "batch_number") { value }
              pdf_link: field(key: "pdf_link") { value }
              best_by_date: field(key: "best_by_date") { value }
            }
            cursor
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    `;

    const response = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': ACCESS_TOKEN,
      },
      body: JSON.stringify({ query }),
    });

    const { data, errors } = await response.json();

    if (errors) {
      console.error('GraphQL errors:', errors);
      throw new Error('GraphQL query failed');
    }

    const edges = data.metaobjects?.edges || [];
    edges.forEach(edge => {
      const coa = {
        date: edge.node.date?.value,
        product: edge.node.product_name?.value,
        batch_number: edge.node.batch_number?.value,
        pdf_link: edge.node.pdf_link?.value,
        best_by_date: edge.node.best_by_date?.value,
      };
      if (coa.date) allCOAs.push(coa); // Only add if has date
    });

    after = data.metaobjects?.pageInfo?.hasNextPage ? data.metaobjects.pageInfo.endCursor : null;
  } while (after);

  // Sort by date descending
  allCOAs.sort((a, b) => new Date(b.date) - new Date(a.date));
  return allCOAs;
}

// ---- Home route - OAuth redirect ----
app.get('/', (req, res) => {
  const installUrl = `https://${SHOP}/admin/oauth/authorize?client_id=${process.env.SHOPIFY_API_KEY}&scope=${process.env.SHOPIFY_SCOPES}&redirect_uri=${process.env.SHOPIFY_REDIRECT_URI}&state=123&grant_options[]=per-user`;
  console.log('➡️ Redirecting to Shopify install URL:', installUrl);
  res.redirect(installUrl);
});

// ---- OAuth callback ----
app.get('/auth/callback', async (req, res) => {
  const { shop, code, state } = req.query;

  if (!shop || !code) {
    return res.status(400).send('Missing shop or code parameter.');
  }

  try {
    const tokenResponse = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: process.env.SHOPIFY_API_KEY,
        client_secret: process.env.SHOPIFY_API_SECRET,
        code,
      }),
    });

    const data = await tokenResponse.json();

    if (data.access_token) {
      console.log('✅ Access Token:', data.access_token);
      res.send(`App installed! Paste this access token into .env as SHOPIFY_ACCESS_TOKEN and restart:<br><pre>${data.access_token}</pre>`);
    } else {
      console.error('❌ Failed to get access token:', data);
      res.status(500).send('Failed to retrieve access token. Check server console.');
    }
  } catch (error) {
    console.error('FetchError:', error);
    res.status(500).send('Error during token exchange.');
  }
});

// ---- Proxy verification middleware ----
function verifyProxy(req, res, next) {
  const { signature, ...query } = req.query;
  if (!signature) return res.status(401).send('Missing signature');

  const queryString = new URLSearchParams(query).toString();
  const calculatedSignature = crypto
    .createHmac('sha256', process.env.SHOPIFY_API_SECRET)
    .update(queryString)
    .digest('hex');

  if (calculatedSignature !== signature) {
    return res.status(401).send('Invalid signature');
  }
  next();
}

// ---- Routes ----
app.get('/proxy/coas', verifyProxy, async (req, res) => {
  try {
    const coas = await fetchAllCOAs();
    res.json(coas);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch COAs' });
  }
});

app.get('/api/coas', async (req, res) => {
  try {
    const coas = await fetchAllCOAs();
    res.json(coas);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch COAs' });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});