// server.js
import express from 'express';
import fetch from 'node-fetch';
import cors from 'cors';
import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

const app = express();

// Middleware
app.use(cors({
  origin: (origin, callback) => {
    if (process.env.NODE_ENV === 'production') {
      const allowedOrigins = [
        `https://${process.env.SHOPIFY_SHOP}`,
        'https://metaobject-paginator.vercel.app',
      ];
      if (allowedOrigins.includes(origin) || !origin) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    } else {
      callback(null, true);
    }
  },
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
  NODE_ENV = 'development',
} = process.env;

// Validate required env vars
const requiredEnvVars = ['SHOPIFY_SHOP', 'SHOPIFY_API_KEY', 'SHOPIFY_API_SECRET', 'SHOPIFY_ACCESS_TOKEN'];
requiredEnvVars.forEach((envVar) => {
  if (!process.env[envVar]) {
    console.error(`Missing environment variable: ${envVar}`);
    throw new Error(`Missing environment variable: ${envVar}`);
  }
});

const API_VERSION = '2025-10';

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    shop: SHOPIFY_SHOP || 'MISSING',
    apiKeySet: !!SHOPIFY_API_KEY,
    tokenSet: !!SHOPIFY_ACCESS_TOKEN,
    environment: NODE_ENV,
  });
});

// Fetch paginated COAs
async function fetchAllCOAs(first = 50, after = null) {
  const query = `
    query($first: Int!, $after: String) {
      metaobjects(type: "certificates_of_analysis", first: $first, after: $after, sortKey: "updated_at", reverse: true) {
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

  let attempt = 0;
  const maxAttempts = 3;

  while (attempt < maxAttempts) {
    try {
      const response = await fetch(`https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/graphql.json`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
        },
        body: JSON.stringify({
          query,
          variables: { first, after },
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('GraphQL HTTP error:', response.status, errorText);
        throw new Error(`GraphQL request failed: ${response.status}`);
      }

      const { data, errors } = await response.json();

      if (errors) {
        console.error('GraphQL errors:', JSON.stringify(errors, null, 2));
        throw new Error(`GraphQL errors: ${JSON.stringify(errors)}`);
      }

      const coas = (data.metaobjects?.edges || []).map(edge => ({
        id: edge.node.id,
        date: edge.node.date?.value,
        product: edge.node.product_name?.value,
        batch_number: edge.node.batch_number?.value,
        pdf_link: edge.node.pdf_link?.value,
        best_by_date: edge.node.best_by_date?.value,
      })).filter(coa => coa.date && coa.product);

      return {
        coas,
        pageInfo: data.metaobjects?.pageInfo || { hasNextPage: false, endCursor: null },
      };
    } catch (error) {
      attempt++;
      if (attempt >= maxAttempts) {
        console.error('Max retry attempts reached:', error);
        throw error;
      }
      console.warn(`Retrying fetchAllCOAs (attempt ${attempt}):`, error.message);
      await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
    }
  }
}

// App proxy verification
function verifyAppProxy(req, res, next) {
  try {
    const signature = req.get('X-Shopify-Hmac-Sha256') || req.query.signature;
    const queryString = req.url.split('?')[1];
    const body = JSON.stringify(req.body);

    if (!signature) {
      console.error('Missing proxy signature');
      return res.status(401).json({ error: 'Missing signature' });
    }

    let calculatedHmac;
    if (req.method === 'POST' && body) {
      calculatedHmac = crypto
        .createHmac('sha256', SHOPIFY_API_SECRET)
        .update(body, 'utf8')
        .digest('base64');
    } else if (queryString) {
      calculatedHmac = crypto
        .createHmac('sha256', SHOPIFY_API_SECRET)
        .update(queryString, 'utf8')
        .digest('base64');
    }

    if (!calculatedHmac || calculatedHmac !== signature) {
      console.error('Invalid proxy signature');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    next();
  } catch (error) {
    console.error('Proxy verification error:', error);
    res.status(500).json({ error: 'Proxy verification failed' });
  }
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
    console.error('OAuth error:', error);
    res.status(500).send('OAuth failed');
  }
});

// App proxy route
app.all('/proxy/coas', verifyAppProxy, async (req, res) => {
  try {
    const { first = 50, after } = req.query;
    const result = await fetchAllCOAs(parseInt(first), after);
    res.json(result);
  } catch (err) {
    console.error('Proxy error:', err);
    res.status(500).json({ error: 'Failed to fetch COAs' });
  }
});

// API route (for testing)
app.get('/api/coas', async (req, res) => {
  try {
    const { first = 50, after } = req.query;
    const result = await fetchAllCOAs(parseInt(first), after);
    res.json(result);
  } catch (err) {
    console.error('API error:', err);
    res.status(500).json({ error: 'Failed to fetch COAs' });
  }
});
// Webhook verification middleware
function verifyWebhook(req, res, next) {
  const hmac = req.get('X-Shopify-Hmac-Sha256');
  if (!hmac) {
    console.log('Missing webhook HMAC');
    return res.status(401).send('Missing HMAC');
  }
  const body = JSON.stringify(req.body);
  const calculatedHmac = crypto
    .createHmac('sha256', process.env.SHOPIFY_API_SECRET)
    .update(body, 'utf8')
    .digest('base64');
  if (calculatedHmac !== hmac) {
    console.log('Invalid webhook HMAC');
    return res.status(401).send('Invalid HMAC');
  }
  next();
}

app.post('/webhooks/app/uninstalled', express.json(), verifyWebhook, async (req, res) => {
  console.log('Received app/uninstalled webhook:', req.body);
  res.status(200).send('Webhook received');
});

app.post('/webhooks/app/scopes_updated', express.json(), verifyWebhook, async (req, res) => {
  console.log('Received app/scopes_updated webhook:', req.body);
  res.status(200).send('Webhook received');
});
// Export for Vercel
export default app;