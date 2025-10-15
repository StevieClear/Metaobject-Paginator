const express = require('express');
const fetch = require('node-fetch'); // Make sure you installed node-fetch@2
const cors = require('cors');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

// ---- CONFIG ----
const SHOP = '8th-wonder-development.myshopify.com';  // Your dev store domain
const SHOPIFY_API_SECRET = '32c3c0b4747fbb14509a013a5d6d1c68';     // Your API secret from Shopify
const API_VERSION = '2025-10';

// ---- Helper to fetch paginated metaobjects ----
async function fetchAllCOAs() {
    const allCOAs = [];
    let cursor = null;

    do {
        const query = `
        {
          metaobjects(first: 50${cursor ? `, after: "${cursor}"` : ''}, type: "certificates_of_analysis") {
            edges {
              cursor
              node {
                id
                field_values {
                  key
                  value
                }
              }
            }
            pageInfo {
              hasNextPage
            }
          }
        }`;

        const res = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Shopify-Access-Token': ADMIN_API_SECRET,
            },
            body: JSON.stringify({ query }),
        });

        const data = await res.json();

        if (data.errors) {
            console.error('GraphQL errors:', data.errors);
            throw new Error('GraphQL query failed');
        }

        const edges = data.data.metaobjects.edges;
        edges.forEach(edge => {
            const coa = {};
            edge.node.field_values.forEach(f => {
                coa[f.key] = f.value;
            });
            allCOAs.push(coa);
        });

        cursor = edges.length > 0 ? edges[edges.length - 1].cursor : null;
    } while (cursor);

    return allCOAs;
}

// ---- Route for frontend ----
app.get('/coas', async (req, res) => {
    try {
        const coas = await fetchAllCOAs();
        res.json(coas);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch COAs' });
    }
});

// ---- Start server ----
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
