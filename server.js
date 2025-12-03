import express from 'express';
import fetch from 'node-fetch';
import cors from 'cors';
import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

const app = express();

// Environment variables
const {
  SHOPIFY_SHOP,
  SHOPIFY_ACCESS_TOKEN,
  SHOPIFY_API_SECRET,
  NODE_ENV = 'development'
} = process.env;

const API_VERSION = '2025-10';

// Health check
app.get('/health', async (req, res) => {
  res.json({
    status: 'OK',
    shop: SHOPIFY_SHOP || 'MISSING',
    hasAccessToken: !!SHOPIFY_ACCESS_TOKEN,
    hasApiSecret: !!SHOPIFY_API_SECRET,
    environment: NODE_ENV
  });
});

// Fetch all COAs with pagination
async function fetchAllCOAs() {
  if (!SHOPIFY_SHOP) {
    throw new Error('SHOPIFY_SHOP environment variable not set');
  }
  if (!SHOPIFY_ACCESS_TOKEN) {
    throw new Error('SHOPIFY_ACCESS_TOKEN environment variable not set');
  }

  console.log('fetchAllCOAs called for shop:', SHOPIFY_SHOP);
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
        'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
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

  console.log(`Fetched ${allCOAs.length} COAs`);
  return allCOAs;
}

// App proxy verification (query param-based)
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

// Middleware
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

// Routes
app.get('/', (req, res) => {
  res.send(`
    <h1>Metaobject Paginator - Custom App</h1>
    <p>This is a custom app for ${SHOPIFY_SHOP || 'your Shopify store'}.</p>
    <p>App proxy endpoint: <code>/coas</code></p>
    <p>Health check: <a href="/health">/health</a></p>
  `);
});

// OAuth callback - displays token for manual copy
app.get('/auth/callback', async (req, res) => {
  const { shop, code } = req.query;

  if (!shop || !code) {
    return res.status(400).send('Missing shop or code parameter');
  }

  try {
    const { SHOPIFY_API_KEY, SHOPIFY_API_SECRET } = process.env;

    if (!SHOPIFY_API_KEY || !SHOPIFY_API_SECRET) {
      throw new Error('Missing SHOPIFY_API_KEY or SHOPIFY_API_SECRET in environment variables');
    }

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
      throw new Error(`OAuth failed: ${tokenResponse.status} - ${errText}`);
    }

    const data = await tokenResponse.json();

    if (data.access_token) {
      res.send(`
        <h1>✅ OAuth Success for ${shop}!</h1>
        <h2>Copy Your Access Token:</h2>
        <p style="background: #f0f0f0; padding: 20px; font-family: monospace; word-break: break-all; font-size: 14px;">
          ${data.access_token}
        </p>
        <p><strong>Instructions:</strong></p>
        <ol>
          <li>Copy the entire token above</li>
          <li>Go to Vercel → metaobject-paginator → Settings → Environment Variables</li>
          <li>Update SHOPIFY_ACCESS_TOKEN with this token</li>
          <li>Redeploy the app</li>
        </ol>
        <p><a href="/">Back to home</a></p>
      `);
    } else {
      res.status(500).send(`Failed to get token: ${JSON.stringify(data)}`);
    }
  } catch (error) {
    console.error('OAuth callback error:', error);
    res.status(500).send(`OAuth error: ${error.message}`);
  }
});

// App proxy route
app.all('/coas', verifyAppProxy, async (req, res) => {
  try {
    console.log('Received /coas request from:', req.query.shop);
    const coas = await fetchAllCOAs();
    console.log('Sending COAs:', coas.length);
    res.json(coas);
  } catch (err) {
    console.error('Full proxy error:', err.message, err.stack);
    res.status(500).json({ error: `Failed to fetch COAs: ${err.message}` });
  }
});

// API route (for testing, no proxy verification)
app.get('/api/coas', async (req, res) => {
  try {
    console.log('Received /api/coas request');
    const coas = await fetchAllCOAs();
    console.log('Sending COAs:', coas.length);
    res.json(coas);
  } catch (err) {
    console.error('API error:', err.message, err.stack);
    res.status(500).json({ error: `Failed to fetch COAs: ${err.message}` });
  }
});

// Export for Vercel
export default app;