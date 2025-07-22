require("dotenv").config();

const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const admin = require("firebase-admin");
const { v4: uuidv4 } = require("uuid");
const axios = require("axios");

// Initialize express app
const app = express();
app.use(cors());
app.use(bodyParser.json());

// Firebase admin setup
let serviceAccount;
try {
    // Get the service account JSON string from the environment variable
    const serviceAccountString = process.env.FIREBASE_SERVICE_ACCOUNT;

    if (!serviceAccountString) {
        throw new Error("FIREBASE_SERVICE_ACCOUNT environment variable is not set.");
    }

    // Parse the JSON string into a JavaScript object
    serviceAccount = JSON.parse(serviceAccountString);

    // Initialize Firebase Admin SDK
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
    });
    console.log("Firebase Admin SDK initialized successfully!");
} catch (error) {
    console.error("Firebase Admin SDK initialization error:", error.message);
    // It's critical for your app to run, so exit if Firebase cannot initialize
    process.exit(1);
}


const db = admin.firestore();

// Paystack config
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET; // Ensure PAYSTACK_SECRET is also set in Replit secrets

// Helper functions
const generateReferralLink = (uid) => `https://vest.com/ref/${uid}`;

// Routes

// Signup Route
app.post("/signup", async (req, res) => {
    const { email, password, referredBy } = req.body;
    try {
        const userRecord = await admin.auth().createUser({ email, password });
        const uid = userRecord.uid;
        const referralLink = generateReferralLink(uid);

        const userData = {
            uid,
            email,
            referralLink,
            referredBy: referredBy || null,
            balance: 0,
            teamCount: 0,
            dailyActivities: [],
            createdAt: new Date().toISOString(),
        };

        await db.collection("users").doc(uid).set(userData);
        res.status(201).json({ message: "User created", user: userData });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Signin Route
app.post("/signin", async (req, res) => {
    const { email } = req.body;
    try {
        const user = await admin.auth().getUserByEmail(email);
        const userData = (await db.collection("users").doc(user.uid).get()).data();
        res.json({ user: userData });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Recharge Route
app.post("/recharge", async (req, res) => {
    const { uid, amount } = req.body;

    try {
        const response = await axios.post(
            "https://api.paystack.co/transaction/initialize",
            {
                email: (await admin.auth().getUser(uid)).email,
                amount: amount * 100,
            },
            {
                headers: {
                    Authorization: `Bearer ${PAYSTACK_SECRET}`,
                    "Content-Type": "application/json",
                },
            }
        );

        res.json({ authorization_url: response.data.data.authorization_url });
    } catch (err) {
        res.status(500).json({ error: "Recharge initialization failed" });
    }
});

// Webhook Simulation (after recharge)
app.post("/paystack/webhook", async (req, res) => {
    const { event, data } = req.body;

    // IMPORTANT: In a real application, you *must* verify the Paystack webhook signature
    // to ensure the request is genuinely from Paystack and hasn't been tampered with.
    // Paystack provides a guide on how to do this:
    // https://paystack.com/docs/api/webhooks/#verifying-webhooks

    if (event === "charge.success") {
        const { email } = data.customer;
        const amount = data.amount; // Amount is already in kobo from Paystack

        try {
            const userRecord = await admin.auth().getUserByEmail(email);
            const userRef = db.collection("users").doc(userRecord.uid);

            await db.runTransaction(async (t) => {
                const doc = await t.get(userRef);
                if (!doc.exists) {
                    throw new Error("User not found for successful transaction.");
                }
                const currentBalance = doc.data().balance || 0;
                // Paystack amount is in kobo, convert to naira/main currency (divide by 100)
                const newBalance = currentBalance + amount / 100;
                t.update(userRef, { balance: newBalance });
            });
            console.log(`User ${email} recharged ${amount / 100} successfully.`);
        } catch (error) {
            console.error("Error processing Paystack webhook:", error.message);
            // Even if there's an error, still send 200 to Paystack to avoid retries
            // but log the error for manual investigation.
        }
    }

    res.sendStatus(200); // Always send 200 OK to Paystack webhooks
});

// Log user activity
app.post("/activity", async (req, res) => {
    const { uid, activity } = req.body;
    try {
        const userRef = db.collection("users").doc(uid);
        await userRef.update({
            dailyActivities: admin.firestore.FieldValue.arrayUnion({
                activity,
                timestamp: new Date().toISOString(),
            }),
        });
        res.json({ message: "Activity logged" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get user info
app.get("/user/:uid", async (req, res) => {
    const { uid } = req.params;
    try {
        const doc = await db.collection("users").doc(uid).get();
        if (!doc.exists) return res.status(404).json({ error: "User not found" });
        res.json(doc.data());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
