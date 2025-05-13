// server.js
require("dotenv").config();

const express = require("express");
const axios = require("axios");
const cors = require("cors");
const helmet = require("helmet");
const admin = require("firebase-admin");

// ── Load GCP Service Account from ENV ────────────────────────
if (!process.env.GCP_SERVICE_ACCOUNT_JSON) {
  console.error("❌ GCP_SERVICE_ACCOUNT_JSON is missing");
  process.exit(1);
}
const serviceAccount = JSON.parse(process.env.GCP_SERVICE_ACCOUNT_JSON);

// ── Initialize Firebase Admin ────────────────────────────────
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();

const app = express();
app.use(cors());
app.use(express.json());

// ── Security headers ─────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use((req, res, next) => {
  const widgetOrigin =
    process.env.HYPERPAY_ENV === "prod"
      ? "https://eu-prod.oppwa.com"
      : "https://eu-test.oppwa.com";
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

const PORT = process.env.PORT || 5002;
const BASE_URL =
  process.env.HYPERPAY_ENV === "prod"
    ? "https://eu-prod.oppwa.com/v1/checkouts"
    : "https://eu-test.oppwa.com/v1/checkouts";
const WIDGET_ORIGIN =
  process.env.HYPERPAY_ENV === "prod"
    ? "https://eu-prod.oppwa.com"
    : "https://eu-test.oppwa.com";
const ACCESS_TOKEN = process.env.HYPERPAY_ACCESS_TOKEN;
const ENTITY_ID = process.env.HYPERPAY_ENTITY_ID;
const CURRENCY = process.env.CURRENCY || "SAR";
const FRONTEND_URL =
  process.env.FRONTEND_URL ||
  "https://marsos.vercel.app/" ||
  "http://localhost:3000";

// ── Healthcheck ─────────────────────────────────────────────
app.get("/", (_req, res) => {
  res.send(
    `✅ HyperPay backend (${process.env.HYPERPAY_ENV || "test"}) running.`
  );
});

// ── 1️⃣ Create checkout session ─────────────────────────────
app.post("/api/create-checkout", async (req, res) => {
  const { amount, email, name, street, city, state, country, postcode } =
    req.body;
  if (!name || !amount) {
    return res
      .status(400)
      .json({ error: "Missing required fields: name or amount" });
  }

  const data = new URLSearchParams({
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

  console.log("📤 Sending to HyperPay:", Object.fromEntries(data.entries()));

  try {
    const { data: resp } = await axios.post(BASE_URL, data, {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Bearer ${ACCESS_TOKEN}`,
      },
    });
    console.log("✅ HyperPay Response:", resp);
    if (resp.id) return res.json({ checkoutId: resp.id });
    return res
      .status(500)
      .json({ error: "No checkoutId returned", details: resp });
  } catch (err) {
    const details = err.response?.data || err.message;
    console.error("❌ HyperPay Error:", details);
    return res
      .status(500)
      .json({ error: "Failed to create checkout", details });
  }
});

// ── 2️⃣ Shopper-result: verify once, persist order, clear cart, redirect ───
app.get("/api/payment-status", async (req, res) => {
  const { resourcePath, userId, supplierId } = req.query;
  if (!resourcePath || !userId || !supplierId) {
    return res
      .status(400)
      .json({ error: "Missing resourcePath, userId or supplierId" });
  }

  try {
    // Fetch HyperPay status
    const { data } = await axios.get(
      `${WIDGET_ORIGIN}${resourcePath}?entityId=${ENTITY_ID}`,
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
    );
    console.log("✅ Payment Status Response:", data);

    const code = data.result.code;
    const desc = data.result.description;
    const successCodes = ["000.000.000", "000.100.110", "000.100.112"];
    if (!successCodes.includes(code)) {
      return res.redirect(
        `${FRONTEND_URL}/payment-failed` +
          `?error=${encodeURIComponent(code)}` +
          `&message=${encodeURIComponent(desc)}`
      );
    }

    // Load cart items for this user & supplier
    const cartSnap = await db
      .collection("carts")
      .doc(userId)
      .collection("items")
      .where("supplierId", "==", supplierId)
      .get();

    const items = cartSnap.docs.map((doc) => doc.data());

    // Persist the order
    const orderId = data.id;
    await db
      .collection("orders")
      .doc(orderId)
      .set({
        transactionId: orderId,
        orderStatus: "Paid",
        paymentMethod: data.paymentType ?? null,
        totalAmount: (data.amount ?? 0).toString(),
        cardBrand: data.card?.brand ?? "N/A",
        userId,
        userEmail: data.customer?.email ?? null,
        userName: data.customer?.givenName ?? null,
        buyerId: userId,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        items,
      });

    // Clear cart items
    const batch = db.batch();
    cartSnap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();

    // Redirect to order-details
    return res.redirect(
      `${FRONTEND_URL}/order-details/${orderId}?supplierId=${supplierId}`
    );
  } catch (err) {
    console.error("❌ Error in payment-status:", err.response?.data || err);
    return res.status(500).send("Error verifying payment");
  }
});

// ── (Optional) verify-payment endpoint ───────────────────────
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
    console.log("✅ Verify Payment Response:", data);
    return res.json({
      success: true,
      transactionId: data.id,
      amount: data.amount,
      paymentType: data.paymentType,
      cardBrand: data.card?.brand ?? null,
      customerName: data.customer?.givenName ?? null,
      customerEmail: data.customer?.email ?? null,
      billing: data.billing || {},
      resourcePath,
    });
  } catch (err) {
    console.error("❌ Error in verify-payment:", err.response?.data || err);
    return res
      .status(500)
      .json({ success: false, error: "Verification failed" });
  }
});

app.listen(PORT, () => {
  console.log(
    `✅ HyperPay server (${
      process.env.HYPERPAY_ENV || "test"
    }) listening on ${PORT}`
  );
});
