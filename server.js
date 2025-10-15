// server.js
import express from 'express';
import fetch from 'node-fetch';
import cors from 'cors';
import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({
  origin: process.env.NODE_ENV === 'production' ? false : true, // Disable CORS in prod (app proxy handles it)
}));
app.use(express.json());

// Environment variables with validation
const {
  SHOPIFY_SHOP,
  SHOPIFY_API_KEY,
  SHOPIFY_API_SECRET,
  SHOPIFY_SCOPES,
  SHOPIFY_ACCESS_TOKEN,
  SHOPIFY_REDIRECT_URI,
  NODE_ENV = 'development'
} = process.env;

// Validate required env vars
if (!SHOPIFY_SHOP) throw new Error('SHOPIFY_SHOP is required');
if (!SHOPIFY_API_KEY) throw new Error('SHOPIFY_API_KEY is required');
if (!SHOPIFY_API_SECRET) throw new Error('SHOPIFY_API_SECRET is required');

const API_VERSION = '2025-10';
const ACCESS_TOKEN = SHOPIFY_ACCESS_TOKEN;

// ---- Helper to fetch paginated metaobjects ----
async function fetchAllCOAs() {
  if (!ACCESS_TOKEN) {
    throw new Error('SHOPIFY_ACCESS_TOKEN not set');
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

    const response = await fetch(`https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': ACCESS_TOKEN,
      },
      body: JSON.stringify({ query }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('GraphQL HTTP error:', response.status, errorText);
      throw new Error(`GraphQL request failed: ${response.status}`);
    }

    const { data, errors } = await response.json();

    if (errors) {
      console.error('GraphQL errors:', errors);
      throw new Error(`GraphQL errors: ${JSON.stringify(errors)}`);
    }

    const edges = data.metaobjects?.edges || [];
    edges.forEach(edge => {
      const coa = {
        id: edge.node.id,
        date: edge.node.date?.value,
        product: edge.node.product_name?.value,
        batch_number: edge.node.batch_number?.value,
        pdf_link: edge.node.pdf_link?.value,
        best_by_date: edge.node.best_by_date?.value,
      };
      // Only add if has required fields
      if (coa.date && coa.product) {
        allCOAs.push(coa);
      }
    });

    after = data.metaobjects?.pageInfo?.hasNextPage 
      ? data.metaobjects.pageInfo.endCursor 
      : null;
  } while (after);

  // Sort by date descending
  allCOAs.sort((a, b) => new Date(b.date) - new Date(a.date));
  return allCOAs;
}

// ---- App proxy verification middleware ----
function verifyAppProxy(req, res, next) {
  try {
    // Shopify app proxy sends signature in query params
    const signature = req.get('X-Shopify-Hmac-Sha256') || req.query.signature;
    const body = JSON.stringify(req.body);
    const queryString = req.url.split('?')[1];

    if (!signature) {
      console.error('Missing proxy signature');
      return res.status(401).json({ error: 'Missing signature' });
    }

    // Verify HMAC for body (POST) or query params (GET)
    let calculatedHmac;
    if (req.method === 'POST' && body) {
      calculatedHmac = crypto
        .createHmac('sha256', SHOPIFY_API_SECRET)
        .update(body)
        .digest('base64');
    } else if (queryString) {
      // For GET requests with query params
      calculatedHmac = crypto
        .createHmac('sha256', SHOPIFY_API_SECRET)
        .update(queryString)
        .digest('hex');
    }

    if (!calculatedHmac || calculatedHmac !== signature) {
