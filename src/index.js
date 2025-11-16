// Checkout Service - Microservice for cart and checkout flow
import express from 'express';
import { Pool } from 'pg';
import Redis from 'ioredis';
import axios from 'axios';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import { v4 as uuidv4 } from 'uuid';

const app = express();
const PORT = process.env.PORT || 3002;

// Service URLs
const PRODUCTS_SERVICE = process.env.PRODUCTS_SERVICE_URL || 'http://products-service.platform-services.svc.cluster.local';
const ORDERS_SERVICE = process.env.ORDERS_SERVICE_URL || 'http://orders-service.platform-services.svc.cluster.local';

// Database connection
const db = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://postgres:postgres123@postgres.platform-services.svc.cluster.local:5432/saas_platform',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Redis connection for cart storage
const redis = new Redis(process.env.REDIS_URL || 'redis://redis.platform-services.svc.cluster.local:6379', {
  retryStrategy: (times) => Math.min(times * 50, 2000),
});

// Middleware
app.use(helmet());
app.use(compression());
app.use(cors());
app.use(express.json());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: 'Too many requests from this IP, please try again later.',
});
app.use('/api/', limiter);

// Health check
app.get('/health', async (req, res) => {
  try {
    await db.query('SELECT 1');
    await redis.ping();
    
    // Check if products service is reachable
    let productsHealthy = false;
    try {
      const productsHealth = await axios.get(`${PRODUCTS_SERVICE}/health`, { timeout: 2000 });
      productsHealthy = productsHealth.status === 200;
    } catch (e) {
      console.warn('Products service unreachable:', e.message);
    }
    
    res.json({ 
      status: 'healthy', 
      service: 'checkout-service',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      connections: {
        database: 'connected',
        redis: 'connected',
        productsService: productsHealthy ? 'connected' : 'unreachable'
      }
    });
  } catch (error) {
    res.status(503).json({ 
      status: 'unhealthy', 
      service: 'checkout-service',
      error: error.message 
    });
  }
});

// Metrics endpoint
app.get('/metrics', async (req, res) => {
  const dbPool = db.totalCount;
  const dbIdle = db.idleCount;
  const dbWaiting = db.waitingCount;
  
  res.json({
    service: 'checkout-service',
    memory: process.memoryUsage(),
    uptime: process.uptime(),
    database: {
      totalConnections: dbPool,
      idleConnections: dbIdle,
      waitingConnections: dbWaiting,
    },
  });
});

// ==================== CART API ====================

// GET /api/cart/:session_id - Get cart
app.get('/api/cart/:session_id', async (req, res) => {
  try {
    const { session_id } = req.params;
    const { tenant_id } = req.query;
    
    if (!tenant_id) {
      return res.status(400).json({ error: 'tenant_id is required' });
    }

    const cacheKey = `cart:${tenant_id}:${session_id}`;
    const cached = await redis.get(cacheKey);
    
    if (cached) {
      return res.json(JSON.parse(cached));
    }

    // Return empty cart if not found
    const emptyCart = {
      session_id,
      tenant_id,
      items: [],
      subtotal: 0,
      total: 0,
      item_count: 0
    };
    
    res.json(emptyCart);
  } catch (error) {
    console.error('Error fetching cart:', error);
    res.status(500).json({ error: 'Failed to fetch cart' });
  }
});

// POST /api/cart/:session_id/items - Add item to cart
app.post('/api/cart/:session_id/items', async (req, res) => {
  try {
    const { session_id } = req.params;
    const { tenant_id, product_id, quantity = 1 } = req.body;
    
    if (!tenant_id || !product_id) {
      return res.status(400).json({ error: 'tenant_id and product_id are required' });
    }

    // Fetch product details from products service
    let product;
    try {
      const productResponse = await axios.get(`${PRODUCTS_SERVICE}/api/products/${product_id}?tenant_id=${tenant_id}`, {
        timeout: 3000
      });
      product = productResponse.data;
    } catch (error) {
      return res.status(404).json({ error: 'Product not found or products service unavailable' });
    }

    // Get current cart
    const cacheKey = `cart:${tenant_id}:${session_id}`;
    const cached = await redis.get(cacheKey);
    let cart = cached ? JSON.parse(cached) : {
      session_id,
      tenant_id,
      items: [],
      subtotal: 0,
      total: 0,
      item_count: 0
    };

    // Check if product already in cart
    const existingItemIndex = cart.items.findIndex(item => item.product_id === product_id);
    
    if (existingItemIndex >= 0) {
      // Update quantity
      cart.items[existingItemIndex].quantity += quantity;
      cart.items[existingItemIndex].line_total = cart.items[existingItemIndex].quantity * product.price;
    } else {
      // Add new item
      cart.items.push({
        product_id: product.id,
        title: product.title,
        handle: product.handle,
        price: product.price,
        quantity: quantity,
        line_total: quantity * product.price
      });
    }

    // Recalculate totals
    cart.subtotal = cart.items.reduce((sum, item) => sum + item.line_total, 0);
    cart.total = cart.subtotal; // Future: add tax, shipping, discounts
    cart.item_count = cart.items.reduce((sum, item) => sum + item.quantity, 0);
    cart.updated_at = new Date().toISOString();

    // Save to Redis (24 hour expiry)
    await redis.setex(cacheKey, 86400, JSON.stringify(cart));

    res.json(cart);
  } catch (error) {
    console.error('Error adding to cart:', error);
    res.status(500).json({ error: 'Failed to add item to cart' });
  }
});

// PUT /api/cart/:session_id/items/:product_id - Update cart item quantity
app.put('/api/cart/:session_id/items/:product_id', async (req, res) => {
  try {
    const { session_id, product_id } = req.params;
    const { tenant_id, quantity } = req.body;
    
    if (!tenant_id || quantity === undefined) {
      return res.status(400).json({ error: 'tenant_id and quantity are required' });
    }

    const cacheKey = `cart:${tenant_id}:${session_id}`;
    const cached = await redis.get(cacheKey);
    
    if (!cached) {
      return res.status(404).json({ error: 'Cart not found' });
    }

    let cart = JSON.parse(cached);
    const itemIndex = cart.items.findIndex(item => item.product_id == product_id);
    
    if (itemIndex < 0) {
      return res.status(404).json({ error: 'Item not found in cart' });
    }

    if (quantity <= 0) {
      // Remove item
      cart.items.splice(itemIndex, 1);
    } else {
      // Update quantity
      cart.items[itemIndex].quantity = quantity;
      cart.items[itemIndex].line_total = quantity * cart.items[itemIndex].price;
    }

    // Recalculate totals
    cart.subtotal = cart.items.reduce((sum, item) => sum + item.line_total, 0);
    cart.total = cart.subtotal;
    cart.item_count = cart.items.reduce((sum, item) => sum + item.quantity, 0);
    cart.updated_at = new Date().toISOString();

    await redis.setex(cacheKey, 86400, JSON.stringify(cart));

    res.json(cart);
  } catch (error) {
    console.error('Error updating cart:', error);
    res.status(500).json({ error: 'Failed to update cart' });
  }
});

// DELETE /api/cart/:session_id/items/:product_id - Remove item from cart
app.delete('/api/cart/:session_id/items/:product_id', async (req, res) => {
  try {
    const { session_id, product_id } = req.params;
    const { tenant_id } = req.query;
    
    if (!tenant_id) {
      return res.status(400).json({ error: 'tenant_id is required' });
    }

    const cacheKey = `cart:${tenant_id}:${session_id}`;
    const cached = await redis.get(cacheKey);
    
    if (!cached) {
      return res.status(404).json({ error: 'Cart not found' });
    }

    let cart = JSON.parse(cached);
    cart.items = cart.items.filter(item => item.product_id != product_id);

    // Recalculate totals
    cart.subtotal = cart.items.reduce((sum, item) => sum + item.line_total, 0);
    cart.total = cart.subtotal;
    cart.item_count = cart.items.reduce((sum, item) => sum + item.quantity, 0);
    cart.updated_at = new Date().toISOString();

    await redis.setex(cacheKey, 86400, JSON.stringify(cart));

    res.json(cart);
  } catch (error) {
    console.error('Error removing from cart:', error);
    res.status(500).json({ error: 'Failed to remove item from cart' });
  }
});

// DELETE /api/cart/:session_id - Clear entire cart
app.delete('/api/cart/:session_id', async (req, res) => {
  try {
    const { session_id } = req.params;
    const { tenant_id } = req.query;
    
    if (!tenant_id) {
      return res.status(400).json({ error: 'tenant_id is required' });
    }

    const cacheKey = `cart:${tenant_id}:${session_id}`;
    await redis.del(cacheKey);

    res.json({ success: true, message: 'Cart cleared' });
  } catch (error) {
    console.error('Error clearing cart:', error);
    res.status(500).json({ error: 'Failed to clear cart' });
  }
});

// ==================== CHECKOUT API ====================

// POST /api/checkout/:session_id - Begin checkout process
app.post('/api/checkout/:session_id', async (req, res) => {
  try {
    const { session_id } = req.params;
    const { tenant_id, customer_email, shipping_address, billing_address } = req.body;
    
    if (!tenant_id || !customer_email) {
      return res.status(400).json({ error: 'tenant_id and customer_email are required' });
    }

    // Get cart
    const cacheKey = `cart:${tenant_id}:${session_id}`;
    const cached = await redis.get(cacheKey);
    
    if (!cached) {
      return res.status(404).json({ error: 'Cart not found or empty' });
    }

    const cart = JSON.parse(cached);
    
    if (cart.items.length === 0) {
      return res.status(400).json({ error: 'Cart is empty' });
    }

    // Create checkout session
    const checkout_id = uuidv4();
    const checkout = {
      checkout_id,
      session_id,
      tenant_id,
      customer_email,
      shipping_address,
      billing_address,
      cart: cart,
      status: 'pending',
      created_at: new Date().toISOString()
    };

    // Store checkout session (1 hour expiry)
    await redis.setex(`checkout:${checkout_id}`, 3600, JSON.stringify(checkout));

    res.json({
      checkout_id,
      status: 'pending',
      total: cart.total,
      item_count: cart.item_count,
      expires_at: new Date(Date.now() + 3600000).toISOString()
    });
  } catch (error) {
    console.error('Error creating checkout:', error);
    res.status(500).json({ error: 'Failed to create checkout' });
  }
});

// POST /api/checkout/:checkout_id/complete - Complete checkout and create order
app.post('/api/checkout/:checkout_id/complete', async (req, res) => {
  try {
    const { checkout_id } = req.params;
    const { payment_method = 'card' } = req.body;
    
    // Get checkout session
    const checkoutData = await redis.get(`checkout:${checkout_id}`);
    
    if (!checkoutData) {
      return res.status(404).json({ error: 'Checkout session not found or expired' });
    }

    const checkout = JSON.parse(checkoutData);

    // TODO: Process payment (integrate with Stripe, PayPal, etc.)
    // For now, we'll simulate successful payment
    const payment_successful = true;

    if (!payment_successful) {
      return res.status(400).json({ error: 'Payment failed' });
    }

    // Create order (would call orders-service in production)
    const order_number = `ORD-${Date.now()}`;
    
    // Store order in database
    const orderResult = await db.query(
      `INSERT INTO orders (tenant_id, order_number, customer_email, total, status, items, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
       RETURNING id, order_number, status, created_at`,
      [
        checkout.tenant_id,
        order_number,
        checkout.customer_email,
        checkout.cart.total,
        'processing',
        JSON.stringify(checkout.cart.items)
      ]
    );

    const order = orderResult.rows[0];

    // Clear cart and checkout
    await redis.del(`cart:${checkout.tenant_id}:${checkout.session_id}`);
    await redis.del(`checkout:${checkout_id}`);

    res.json({
      success: true,
      order_id: order.id,
      order_number: order.order_number,
      status: order.status,
      total: checkout.cart.total,
      message: 'Order placed successfully'
    });
  } catch (error) {
    console.error('Error completing checkout:', error);
    res.status(500).json({ error: 'Failed to complete checkout' });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`🛒 Checkout Service running on port ${PORT}`);
  console.log(`🔗 Health check: http://localhost:${PORT}/health`);
  console.log(`📊 Metrics: http://localhost:${PORT}/metrics`);
  console.log(`📦 Products Service: ${PRODUCTS_SERVICE}`);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, closing connections...');
  await db.end();
  await redis.quit();
  process.exit(0);
});
