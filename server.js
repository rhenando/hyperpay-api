// server.js  (or wherever your Express code lives)

require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const helmet = require("helmet");
const admin = require("firebase-admin");

// ── Load GCP Service Account (local file)
const serviceAccount = require("./serviceAccountKey.json");

// ── Initialize Firebase Admin ────────────────────────────────
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const app = express();
app.use(cors());
app.use(express.json());

// ── Security headers (production) ────────────────────────────
app.use(
  helmet({
    contentSecurityPolicy: false,
  })
);
app.use((req, res, next) => {
  const widgetOrigin = "https://eu-prod.oppwa.com";
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      `script-src 'self' 'unsafe-inline' 'unsafe-eval' ${widgetOrigin}`,
      `connect-src 'self' ${widgetOrigin}`,
      `frame-src 'self' ${widgetOrigin}`,
      "img-src 'self' data: https://*",
    ].join("; ")
  );
  next();
});

// ── Configurable variables ───────────────────────────────────
const PORT = process.env.PORT || 5002;
const CHECKOUT_BASE = "https://eu-prod.oppwa.com/v1/checkouts";
const WIDGET_ORIGIN = "https://eu-prod.oppwa.com";
const ACCESS_TOKEN = process.env.HYPERPAY_ACCESS_TOKEN;
const ENTITY_ID = (process.env.HYPERPAY_ENTITY_ID || "").trim();
const CURRENCY = process.env.CURRENCY || "SAR";
const FRONTEND_URL = process.env.FRONTEND_URL || "https://marsos.sa";

// ── Healthcheck ─────────────────────────────────────────────
app.get("/", (_req, res) =>
  res.send("✅ HyperPay backend (production) running.")
);

// ── Create checkout session ──────────────────────────────────
app.post("/api/create-checkout", async (req, res) => {
  const { amount, email, name, street, city, state, country, postcode } =
    req.body;

  // 1) Quick sanity‐check logging:
  console.log("↪︎ /api/create-checkout called with:");
  console.log("   • name:", name);
  console.log("   • amount:", amount);
  console.log("   • ENTITY_ID (server sees):", JSON.stringify(ENTITY_ID));

  if (!name || !amount) {
    return res
      .status(400)
      .json({ error: "Missing required fields: name or amount" });
  }

  if (!ENTITY_ID) {
    return res
      .status(500)
      .json({ error: "HyperPay entity ID is not defined on the server." });
  }

  // 2) Build URLSearchParams exactly as HyperPay expects:
  const params = new URLSearchParams({
    entityId: ENTITY_ID,
    amount: parseFloat(amount).toFixed(2),
    currency: CURRENCY,
    paymentType: "DB",
    merchantTransactionId: `txn_${Date.now()}`,
    "customer.email": (email || "").trim() || "buyer@example.com",
    "customer.givenName": name.trim(),
    "customer.surname": name.trim(),
    "billing.street1": street || "King Fahad Road",
    "billing.city": city || "Riyadh",
    "billing.state": state || "Riyadh",
    "billing.country": country || "SA",
    "billing.postcode": postcode || "12345",
    "customParameters[3DS2_enrolled]": "true",
    "customParameters[3DS2_scenario]": "02",
    "standingInstruction.mode": "INITIAL",
    "standingInstruction.type": "UNSCHEDULED",
  });

  try {
    const { data: resp } = await axios.post(CHECKOUT_BASE, params, {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Bearer ${ACCESS_TOKEN}`,
      },
    });

    console.log("↪︎ HyperPay full response:", JSON.stringify(resp, null, 2));

    if (resp.id) {
      return res.json({ checkoutId: resp.id });
    }

    return res
      .status(500)
      .json({ error: "No checkoutId returned", details: resp });
  } catch (err) {
    const details = err.response?.data || err.message;
    console.error(
      "‼️  HyperPay create-checkout failed:",
      JSON.stringify(details)
    );
    return res
      .status(500)
      .json({ error: "Failed to create checkout", details });
  }
});

// ── Payment-status & order persistence ───────────────────────
app.get("/api/payment-status", async (req, res) => {
  const { resourcePath, userId, supplierId } = req.query;
  if (!resourcePath || !userId || !supplierId) {
    return res
      .status(400)
      .json({ error: "Missing resourcePath, userId or supplierId" });
  }

  try {
    const { data } = await axios.get(
      `${WIDGET_ORIGIN}${resourcePath}?entityId=${ENTITY_ID}`,
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
    );

    console.log("↪︎ Verifying payment with resourcePath:", resourcePath);
    console.log(
      "↪︎ Full verification response:",
      JSON.stringify(data, null, 2)
    );

    const { code, description } = data.result;

    const successCodes = ["000.000.000", "000.100.110", "000.100.112"];
    if (!successCodes.includes(code)) {
      return res.redirect(
        `${FRONTEND_URL}/payment-failed?error=${encodeURIComponent(
          code
        )}&message=${encodeURIComponent(description)}`
      );
    }

    // Fetch cart items
    const cartSnap = await db
      .collection("carts")
      .doc(userId)
      .collection("items")
      .where("supplierId", "==", supplierId)
      .get();
    const items = cartSnap.docs.map((d) => d.data());

    // Persist order
    const orderId = data.id;
    await db
      .collection("orders")
      .doc(orderId)
      .set({
        transactionId: orderId,
        orderStatus: "Paid",
        paymentMethod: data.paymentType,
        totalAmount: data.amount.toString(),
        cardBrand: data.card?.brand || "N/A",
        userId,
        userEmail: data.customer?.email,
        userName: data.customer?.givenName,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        items,
      });

    // Clear cart
    const batch = db.batch();
    cartSnap.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();

    return res.redirect(
      `${FRONTEND_URL}/order-details/${orderId}?supplierId=${supplierId}`
    );
  } catch (err) {
    return res.status(500).send("Error verifying payment");
  }
});

// ── Verify payment endpoint (optional) ───────────────────────
app.post("/api/verify-payment", async (req, res) => {
  const { resourcePath } = req.body;
  if (!resourcePath) {
    return res
      .status(400)
      .json({ success: false, error: "Missing resourcePath" });
  }

  try {
    const { data } = await axios.get(
      `${WIDGET_ORIGIN}${resourcePath}?entityId=${ENTITY_ID}`,
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
    );
    return res.json({
      success: true,
      transactionId: data.id,
      amount: data.amount,
      paymentType: data.paymentType,
      cardBrand: data.card?.brand || null,
      customerName: data.customer?.givenName || null,
      customerEmail: data.customer?.email || null,
      billing: data.billing || {},
      resourcePath,
    });
  } catch (err) {
    return res
      .status(500)
      .json({ success: false, error: "Verification failed" });
  }
});

app.listen(PORT, () => console.log(`✅ HyperPay server listening on ${PORT}`));
