require("dotenv").config();

const express = require("express");
const axios = require("axios");
const cors = require("cors");
const helmet = require("helmet");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 5002;

// ✅ LIVE HyperPay Configuration
const BASE_URL = "https://eu-prod.oppwa.com/v1/checkouts";
const ACCESS_TOKEN = process.env.HYPERPAY_ACCESS_TOKEN;
const ENTITY_ID = process.env.HYPERPAY_ENTITY_ID;
const CURRENCY = process.env.CURRENCY || "SAR";

app.get("/", (req, res) => {
  res.send("✅ HyperPay backend is running (LIVE MODE).");
});

app.use(
  helmet({
    contentSecurityPolicy: false,
  })
);

app.use((req, res, next) => {
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; " +
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://eu-prod.oppwa.com; " +
      "connect-src 'self' https://eu-prod.oppwa.com; " +
      "frame-src 'self' https://eu-prod.oppwa.com; " +
      "img-src 'self' data: https://*;"
  );
  next();
});

app.post("/api/create-checkout", async (req, res) => {
  const { amount, email, name, street, city, state, country, postcode } =
    req.body;

  if (!name || !amount) {
    console.error("❌ Missing required fields:", { name, amount });
    return res
      .status(400)
      .json({ error: "Missing required fields: name or amount" });
  }

  const fullName = name?.trim() || "Guest Buyer";
  const validEmail = email?.trim() || "buyer@example.com";

  const data = new URLSearchParams({
    entityId: ENTITY_ID,
    amount: parseFloat(amount).toFixed(2),
    currency: CURRENCY,
    paymentType: "DB",
    merchantTransactionId: `txn_${Date.now()}`,
    "customer.email": validEmail,
    "customer.givenName": fullName,
    "customer.surname": fullName,
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

  console.log(
    "📤 Sending to HyperPay LIVE:",
    JSON.stringify(Object.fromEntries(data), null, 2)
  );

  try {
    const response = await axios.post(BASE_URL, data, {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Bearer ${ACCESS_TOKEN}`,
      },
    });

    console.log(
      "✅ HyperPay Response:",
      JSON.stringify(response.data, null, 2)
    );

    if (response.data?.id) {
      res.json({ checkoutId: response.data.id });
    } else {
      res.status(500).json({
        error: "HyperPay did not return a valid checkoutId",
        details: response.data,
      });
    }
  } catch (error) {
    const err = error.response?.data || error.message;
    console.error("❌ HyperPay Error Response:", JSON.stringify(err, null, 2));
    res.status(500).json({ error: "Failed to create checkout", details: err });
  }
});

app.get("/api/payment-status", async (req, res) => {
  const { resourcePath } = req.query;
  if (!resourcePath)
    return res.status(400).json({ error: "Missing resourcePath" });

  const url = `https://eu-prod.oppwa.com${resourcePath}?entityId=${ENTITY_ID}`;

  try {
    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
    });

    const resultCode = response.data.result.code;
    const resultDescription = response.data.result.description;

    console.log(
      "✅ Payment Status Response:",
      JSON.stringify(response.data, null, 2)
    );

    const successCodes = ["000.000.000", "000.100.110", "000.100.112"];

    if (successCodes.includes(resultCode)) {
      res.redirect("https://marsos.sa/payment-success");
    } else {
      res.redirect(
        `https://marsos.sa/payment-failed?error=${resultCode}&message=${encodeURIComponent(
          resultDescription
        )}`
      );
    }
  } catch (error) {
    const err = error.response?.data || error.message;
    console.error(
      "❌ Error verifying payment status:",
      JSON.stringify(err, null, 2)
    );
    res
      .status(500)
      .json({ error: "Payment verification failed", details: err });
  }
});

app.post("/api/verify-payment", async (req, res) => {
  const { resourcePath } = req.body;
  if (!resourcePath)
    return res.status(400).json({ error: "Missing resourcePath" });

  const url = `https://eu-prod.oppwa.com${resourcePath}?entityId=${ENTITY_ID}`;

  try {
    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
    });

    const resultCode = response.data.result.code;
    const resultDescription = response.data.result.description;

    console.log(
      "✅ Payment verification result:",
      JSON.stringify(response.data, null, 2)
    );

    return res.status(200).json({
      success: true,
      result: { code: resultCode, description: resultDescription },
      amount: response.data.amount,
      paymentType: response.data.paymentType,
      cardBrand: response.data.card?.brand,
      customerEmail: response.data.customer?.email,
      customerName: response.data.customer?.givenName || "Buyer",
      transactionId: response.data.id,
      resourcePath,
    });
  } catch (error) {
    const err = error.response?.data || error.message;
    console.error("❌ Error verifying payment:", JSON.stringify(err, null, 2));
    res.status(500).json({ error: "Failed to verify payment", details: err });
  }
});

app.listen(PORT, () => {
  console.log(`✅ LIVE Server running on port ${PORT}`);
});
