# Checkout Service

Microservice for cart management and checkout flow in the FV SaaS platform.

## 🎯 Purpose

Handles all cart operations and checkout processing:
- Cart session management
- Product validation via Products Service
- Checkout flow and order creation
- Payment processing coordination

## 📦 Features

- **Cart Management**: Add, update, remove items with Redis storage
- **Session Handling**: 24-hour cart expiration
- **Product Validation**: Real-time product data from Products Service
- **Checkout Flow**: Multi-step checkout with validation
- **Order Creation**: Seamless handoff to Orders Service
- **Health Checks**: Database, Redis, and service dependency monitoring

## 🚀 API Endpoints

### Cart Operations

**Get Cart**
```
GET /api/cart/:session_id?tenant_id={id}
```

**Add Item**
```
POST /api/cart/:session_id/items
{
  "tenant_id": "uuid",
  "product_id": "uuid",
  "quantity": 1
}
```

**Update Quantity**
```
PUT /api/cart/:session_id/items/:product_id
{
  "tenant_id": "uuid",
  "quantity": 2
}
```

**Remove Item**
```
DELETE /api/cart/:session_id/items/:product_id?tenant_id={id}
```

**Clear Cart**
```
DELETE /api/cart/:session_id?tenant_id={id}
```

### Checkout Operations

**Begin Checkout**
```
POST /api/checkout/:session_id
{
  "tenant_id": "uuid",
  "customer_email": "customer@example.com",
  "shipping_address": { ... },
  "billing_address": { ... }
}
```

**Complete Checkout**
```
POST /api/checkout/:checkout_id/complete
{
  "payment_method": "card"
}
```

## 🏗️ Architecture

### Service Communication
```
Storefront → Checkout Service → Products Service
                              → Orders Service
```

### Data Flow
1. Customer adds products to cart
2. Checkout validates products with Products Service
3. Payment processed (Stripe/PayPal integration)
4. Order created via Orders Service
5. Cart cleared on successful order

### Storage
- **Redis**: Cart sessions (24h TTL), checkout sessions (1h TTL)
- **PostgreSQL**: Order records for audit trail

## 🛠️ Local Development

```bash
npm install
npm run dev
```

Service runs on `http://localhost:3002`

## 🐳 Docker Build

```bash
docker build -t mtceel/checkout-service:latest .
docker push mtceel/checkout-service:latest
```

## ☸️ Kubernetes Deployment

```bash
kubectl apply -f k8s/deployment.yaml
```

Check status:
```bash
kubectl get pods -n platform-services -l app=checkout-service
kubectl logs -n platform-services -l app=checkout-service --tail=50
```

## 🔧 Configuration

Environment variables:
- `PORT`: Service port (default: 3002)
- `DATABASE_URL`: PostgreSQL connection string
- `REDIS_URL`: Redis connection string
- `PRODUCTS_SERVICE_URL`: Products Service endpoint
- `ORDERS_SERVICE_URL`: Orders Service endpoint

## 📊 Health & Metrics

**Health Check**
```
GET /health
```
Returns database, Redis, and Products Service status.

**Metrics**
```
GET /metrics
```
Returns memory usage, uptime, connection stats.

## 🔐 Security

- Helmet.js for HTTP headers
- Rate limiting: 200 requests/15min per IP
- CORS enabled for cross-origin requests
- Tenant isolation for all operations

## 🚦 Why Separate Service?

- **Isolation**: Checkout failures don't affect product browsing
- **Scaling**: Scale checkout independently during peak traffic
- **Security**: Payment data isolated from other services
- **Deployment**: Update checkout logic without redeploying products

## 📈 Future Enhancements

- [ ] Payment gateway integration (Stripe, PayPal, Adyen)
- [ ] Abandoned cart recovery
- [ ] Discount code validation
- [ ] Tax calculation service
- [ ] Shipping rate calculation
- [ ] Multi-currency support
- [ ] Guest checkout
- [ ] Save cart for later
