// Server.js before splitting into brands

import express from 'express';
import fetch from 'node-fetch';
import cors from 'cors';
import crypto from 'crypto';
import dotenv from 'dotenv';
import { Redis } from '@upstash/redis';

// Get token for a specific shop from KV
async function getTokenForShop(shop) {
  if (!shop) throw new Error('No shop provided');
  const token = await kv.get(shop);
  if (!token) throw new Error(`No token for ${shop}; run OAuth first`);
  return token;
}

const kv = new Redis({
  url: process.env.KV_REST_API_URL,  // Maps to your https://... var
  token: process.env.KV_REST_API_TOKEN,  // Maps to your full token var
});

dotenv.config();

const app = express();

app.use(express.json());
app.use(cors({
  origin: [
    'https://8th-wonder-development.myshopify.com', 
    'https://dev-8th-wonder.myshopify.com',
    'https://8thwonder.com',
    'http://localhost:3000'
  ],
  credentials: true
}));

// Environment variables
const {
  SHOPIFY_SHOP,
  SHOPIFY_API_KEY,
  SHOPIFY_API_SECRET,
  SHOPIFY_SCOPES = 'read_metaobjects,read_products,read_files,write_app_proxy',
  //SHOPIFY_ACCESS_TOKEN,
  SHOPIFY_REDIRECT_URI,
  NODE_ENV = 'development'
} = process.env;

const API_VERSION = '2025-10';

// Health check
app.get('/health', async (req, res) => {
  const base = { 
    status: 'OK', 
    shop: SHOPIFY_SHOP || 'MISSING',
    apiKeySet: !!SHOPIFY_API_KEY,
    environment: NODE_ENV 
  };
  try {
    const testKey = `health-${Date.now()}`;
    await kv.set(testKey, 'working');
    const testGet = await kv.get(testKey);
    base.kvWorking = testGet === 'working';
    // Clean up
    await kv.del(testKey);
  } catch (e) {
    base.kvWorking = false;
    base.kvError = e.message;
  }
  res.json(base);
});
  };
  try {
    const testKey = `health-${Date.now()}`;
    await kv.set(testKey, 'working');
    const testGet = await kv.get(testKey);
    base.kvWorking = testGet === 'working';
    // Clean up
    await kv.del(testKey);
  } catch (e) {
    base.kvWorking = false;
    base.kvError = e.message;
  }
  res.json(base);
});

// Fetch all COAs with pagination
async function fetchAllCOAs(shopDomain, accessToken) {
  if (!accessToken) {
    throw new Error('SHOPIFY_ACCESS_TOKEN not set');
  }
  if (!shopDomain) {
    throw new Error('SHOPIFY_SHOP domain not provided');
  }

  console.log('fetchAllCOAs called with shop:', shopDomain, 'token exists:', !!accessToken);

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

    const response = await fetch(`https://${shopDomain}/admin/api/${API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken,
      },
      body: JSON.stringify({ query }),
    });

    console.log('GraphQL response status:', response.status);

    if (!response.ok) {
      const text = await response.text();
      console.error('Full GraphQL response body:', text);
      throw new Error(`HTTP ${response.status}: ${text}`);
    }

    const { data, errors } = await response.json();

    if (errors) {
      console.error('GraphQL errors:', JSON.stringify(errors, null, 2));
      throw new Error(`GraphQL query failed: ${errors[0]?.message || 'Unknown error'}`);
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
      if (coa.date && coa.product) {
        allCOAs.push(coa);
      }
    });

    after = data.metaobjects?.pageInfo?.hasNextPage 
      ? data.metaobjects.pageInfo.endCursor 
      : null;
  } while (after);

  console.log(`Fetched ${allCOAs.length} COAs for ${shopDomain}`);
  return allCOAs;
}

// App proxy verification (query param-based, per Shopify docs)
function verifyAppProxy(req, res, next) {
  const signature = req.query.signature;
  
  if (!signature) {
    console.log('Missing proxy signature param');
    return res.status(401).json({ error: 'Missing signature' });
  }

  // Copy query, remove signature
  const query = { ...req.query };
  delete query.signature;

  // Sort keys, join as key=value (arrays comma-joined)
  const sortedParams = Object.keys(query)
    .sort()
    .map(key => `${key}=${Array.isArray(query[key]) ? query[key].join(',') : query[key]}`)
    .join('');

  console.log('Params to hash:', sortedParams);

  // Hash with secret (hex, not base64)
  const calculatedSignature = crypto
    .createHmac('sha256', SHOPIFY_API_SECRET)
    .update(sortedParams)
    .digest('hex');

  console.log('Calculated sig:', calculatedSignature, 'vs Received:', signature);

  // Secure compare
  const isValid = crypto.timingSafeEqual(
    Buffer.from(calculatedSignature),
    Buffer.from(signature)
  );

  if (!isValid) {
    console.log('Invalid proxy signature');
    return res.status(401).json({ error: 'Invalid signature' });
  }
  
  console.log('Proxy signature verification passed');
  next();
}

// Routes
app.get('/', (req, res) => {
  const shop = req.query.shop || SHOPIFY_SHOP;
  if (!shop) {
    return res.status(400).send('Missing shop parameter');
  }

const installUrl = `https://${shop}/admin/oauth/authorize?client_id=${SHOPIFY_API_KEY}&scope=${SHOPIFY_SCOPES || 'read_metaobjects,read_products,read_files,write_app_proxy'}&redirect_uri=${SHOPIFY_REDIRECT_URI}&state=${Date.now()}&access_mode=offline`;  // Add access_mode=offline, remove grant_options  
  console.log('Redirecting to OAuth:', installUrl);
  res.redirect(installUrl);
});

app.get('/auth/callback', async (req, res) => {
  const { shop, code, state } = req.query;

  if (!shop || !code) {
    return res.status(400).send('Missing shop or code');
  }

  try {
    const tokenResponse = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: SHOPIFY_API_KEY,
        client_secret: SHOPIFY_API_SECRET,
        code,
      }),
    });

    if (!tokenResponse.ok) {
      const errText = await tokenResponse.text();
      throw new Error(`OAuth response: ${tokenResponse.status} - ${errText}`);
    }

    const data = await tokenResponse.json();

    if (data.access_token) {
      // Store offline token in KV (key: shop domain)
      await kv.set(shop, data.access_token);
      console.log(`✅ Stored offline token for ${shop}`);
      
      res.send(`<h1>Success for ${shop}!</h1><p>Token auto-saved in KV. <a href="/">Install on another shop</a> (add ?shop=theirshop.myshopify.com)</p>`);
    } else {
      res.status(500).send('Failed to get token: ' + JSON.stringify(data));
    }
  } catch (error) {
    console.error('OAuth error:', error);
    res.status(500).send(`OAuth failed: ${error.message}`);
  }
});

    const data = await tokenResponse.json();

    if (data.access_token) {
      console.log('✅ Access Token for', shop, ':', data.access_token);
      res.send(`<h1>Success for ${shop}!</h1><pre>${data.access_token}</pre><p>Add SHOPIFY_SHOP=${shop} and SHOPIFY_ACCESS_TOKEN to Vercel env vars</p>`);
    } else {
      res.status(500).send('Failed to get token');
    }
  } catch (error) {
    console.error('OAuth error:', error.message, error.stack);
    res.status(500).send(`OAuth failed: ${error.message}`);
  }
});

// App proxy route (now with correct verification)
app.all('/coas', verifyAppProxy, async (req, res) => {
  try {
    const shopDomain = req.query.shop;  // From query param
    console.log('Received /coas request from:', shopDomain);

    // Temporarily disable shop check for dev (re-enable later)
    // if (!shopDomain || shopDomain !== SHOPIFY_SHOP) {
    //   return res.status(403).json({ error: 'Unauthorized shop' });
    // }

    const coas = await fetchAllCOAs(shopDomain, SHOPIFY_ACCESS_TOKEN);
    console.log('Sending COAs:', coas.length);
    res.json(coas);
  } catch (err) {
    console.error('Full proxy error:', err.message, err.stack, { 
      shopDomain: req.query.shop, 
      tokenSet: !!SHOPIFY_ACCESS_TOKEN 
    });
    res.status(500).json({ error: `Failed to fetch COAs: ${err.message}` });
  }
});

// API route (for testing, no proxy)
app.get('/api/coas', async (req, res) => {
  try {
    const shopDomain = SHOPIFY_SHOP;
    console.log('Received /api/coas request');
    const coas = await fetchAllCOAs(shopDomain, SHOPIFY_ACCESS_TOKEN);
    console.log('Sending COAs:', coas.length);
    res.json(coas);
  } catch (err) {
    console.error('API error:', err.message, err.stack);
    res.status(500).json({ error: `Failed to fetch COAs: ${err.message}` });
  }
});

// Export for Vercel
export default app;