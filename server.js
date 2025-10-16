import express from 'express';
import fetch from 'node-fetch';
import cors from 'cors';
import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

const app = express();

// Middleware
app.use(cors({
  origin: ['https:8th-wonder-development.myshopify.com', 'https:dev-8th-wonder.myshopify.com','https:8thwonder.com' 'http://localhost:3000'], 
}));
app.use(express.json());

// Environment variables
const {
  SHOPIFY_SHOP,
  SHOPIFY_API_KEY,
  SHOPIFY_API_SECRET,
  SHOPIFY_SCOPES,
  SHOPIFY_ACCESS_TOKEN,
  SHOPIFY_REDIRECT_URI,
  NODE_ENV = 'development'
} = process.env;

const API_VERSION = '2025-10';

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    shop: SHOPIFY_SHOP || 'MISSING',
    apiKeySet: !!SHOPIFY_API_KEY,
    tokenSet: !!SHOPIFY_ACCESS_TOKEN,
    environment: NODE_ENV 
  });
});

// Fetch all COAs
async function fetchAllCOAs() {
  if (!SHOPIFY_ACCESS_TOKEN) {
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
        'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
      },
      body: JSON.stringify({ query }),
    });

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

// App proxy verification
function verifyAppProxy(req, res, next) {
  const signature = req.get('X-Shopify-Hmac-Sha256');
  
  if (!signature) {
    console.log('Missing proxy signature');
    return res.status(401).json({ error: 'Missing signature' });
  }

  const body = req.body;
  const calculatedHmac = crypto
    .createHmac('sha256', SHOPIFY_API_SECRET)
    .update(JSON.stringify(body), 'utf8')
    .digest('base64');

  if (calculatedHmac !== signature) {
    console.log('Invalid proxy signature');
    return res.status(401).json({ error: 'Invalid signature' });
  }
  
  console.log('HMAC verification passed');
  next();
}

// Routes
app.get('/', (req, res) => {
  const shop = req.query.shop || SHOPIFY_SHOP;
  if (!shop) {
    return res.status(400).send('Missing shop parameter');
  }

  const installUrl = `https://${shop}/admin/oauth/authorize?client_id=${SHOPIFY_API_KEY}&scope=${SHOPIFY_SCOPES || 'read_metaobjects,read_products,read_files,write_app_proxy'}&redirect_uri=${SHOPIFY_REDIRECT_URI}&state=${Date.now()}&grant_options[]=per-user`;
  
  console.log('Redirecting to OAuth:', installUrl);
  res.redirect(installUrl);
});

app.get('/auth/callback', async (req, res) => {
  const { shop, code } = req.query;

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

    const data = await tokenResponse.json();

    if (data.access_token) {
      console.log('✅ Access Token:', data.access_token);
      res.send(`<h1>Success!</h1><pre>${data.access_token}</pre><p>Add to Vercel env vars</p>`);
    } else {
      res.status(500).send('Failed to get token');
    }
  } catch (error) {
    console.error('OAuth error:', error.message, error.stack);
    res.status(500).send(`OAuth failed: ${error.message}`);
  }
});

// App proxy route (HMAC bypassed for debugging)
app.all('/coas', /*verifyAppProxy,*/ async (req, res) => {
  try {
    console.log('Received /coas request from:', req.headers.origin);
    const coas = await fetchAllCOAs();
    console.log('Sending COAs:', coas.length);
    res.json(coas);
  } catch (err) {
    console.error('Proxy error:', err.message, err.stack);
    res.status(500).json({ error: `Failed to fetch COAs: ${err.message}` });
  }
});

// API route (for testing)
app.get('/api/coas', async (req, res) => {
  try {
    console.log('Received /api/coas request from:', req.headers.origin);
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