const express = require("express");
require("dotenv").config();
const cors = require("cors");
const stripe = require("stripe")(process.env.STRIPE_SECRET);
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const crypto = require("crypto");

const app = express();
const port = process.env.PORT || 3000;

// Firebase Admin
const admin = require("firebase-admin");
const serviceAccount = require("./zip-shift-firebase-adminsdk.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// ---------------------------
// Tracking ID Generator
// ---------------------------
function generateTrackingIdSecure() {
  const prefix = "TRK";
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const random = crypto.randomBytes(4).toString("hex").toUpperCase();
  return `${prefix}-${date}-${random}`;
}

// ---------------------------
// MIDDLEWARE: VERIFY TOKEN
// ---------------------------
const verifyFBtoken = async (req, res, next) => {
  const token = req.headers.authorization;

  if (!token) {
    return res.status(401).send({ message: "unauthorized access" });
  }

  try {
    const idToken = token.split(" ")[1];
    const decode = await admin.auth().verifyIdToken(idToken);

    req.decode_email = decode.email; // FIXED: save decoded email
    next();
  } catch (err) {
    return res.status(403).send({ message: "invalid or expired token" });
  }
};

// ---------------------------
app.use(express.json());
app.use(cors());

// MongoDB Connection
const uri = `mongodb+srv://${process.env.DB_NAME}:${process.env.DB_PASS}@cluster0.4xbagdk.mongodb.net/?appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    await client.connect();
    console.log("Connected to MongoDB successfully!");

    const db = client.db("zap_shift");
    const parcelsCollection = db.collection("parcels");
    const paymentCollection = db.collection("payments");
    const usersCollection = db.collection("users");
    const ridersCollection = db.collection("riders");
    const trackingCollection = db.collection("tracking");

    // Tracking log
    const logTracking = async (trackingId, status) => {
      console.log( trackingId, status );

      const log = {
        status,
        trackingId,
        details: status,
        createdAt: new Date(),
      };
      const result = await trackingCollection.insertOne(log);
      return result;
    };

    // ===========
    // Admin verify token
    const verifyAdmin = async (req, res, next) => {
      const email = req.decode_email;
      const filter = { email };
      const user = await usersCollection.findOne(filter);
      if (!user || user.role !== "admin") {
        return res.status(403).send({ message: "Forbidden access" });
      }
      next();
    };

    // ============
    // Riders api
    // ===============
    // app.pa

    app.delete("/riders/:id", async (req, res) => {
      const filter = { _id: new ObjectId(req.params.id) };
      const result = await ridersCollection.deleteOne(filter);
      res.send(result);
    });
    // This is for approve or reject rides
    app.patch("/riders/:id", verifyFBtoken, verifyAdmin, async (req, res) => {
      const id = req.params.id;
      const status = req.body.status;

      const query = { _id: new ObjectId(id) };
      const update = {
        $set: {
          status: status,
          workStatus: "available",
        },
      };
      const result = await ridersCollection.updateOne(query, update);
      if (status === "approved") {
        const email = req.body.email;
        console.log(email);
        const query = { email };
        const updateUser = {
          $set: {
            role: "rider",
          },
        };
        const userResult = await usersCollection.updateOne(query, updateUser);
        res.send(userResult);
      }
    });
    app.post("/riders", async (req, res) => {
      const riders = req.body;
      console.log(riders);

      riders.status = "pending";
      riders.createdAt = new Date();
      const result = await ridersCollection.insertOne(riders);
      res.send(result);
    });

    app.get("/riders", async (req, res) => {
      const query = {};
      const { status, district, workStatus } = req.query;
      if (status) {
        query.status = status;
      }
      if (district) {
        query.district = district;
      }
      if (workStatus) {
        query.workStatus = workStatus;
      }
      const result = await ridersCollection.find(query).toArray();
      res.send(result);
    });
    // ============
    // Users api
    // ===============
    app.get("/users", async (req, res) => {
      const result = await usersCollection.find().toArray();

      res.send(result);
    });
    app.post("/users", async (req, res) => {
      const user = req.body;

      (user.role = "user"), (user.createdAt = new Date()), (email = user.email);
      const exist = await usersCollection.findOne({ email });

      if (exist) {
        return res.send({ message: "already available this user" });
      }
      const result = await usersCollection.insertOne(user);
      res.send(result);
    });
    // This api is for make admin
    app.patch("/user/:id", verifyFBtoken, verifyAdmin, async (req, res) => {
      const id = req.params.id;
      const userInfo = req.body;
      const filter = { _id: new ObjectId(id) };
      const update = {
        $set: {
          role: userInfo.role,
        },
      };
      const result = await usersCollection.updateOne(filter, update);
      res.send(result);
    });
    // THis for see my parcels
    app.get("/users/:email/role", verifyFBtoken, async (req, res) => {
      const email = req.params.email;
      const filter = { email };
      const result = await usersCollection.findOne(filter);
      res.send({ role: result?.role || "user" });
    });

    // ===========================
    // STRIPE CHECKOUT SESSION
    // ===========================
    app.post("/create-checkout-session", async (req, res) => {
      try {
        const paymentInfo = req.body;
        const amount = parseInt(paymentInfo.cost) * 100;

        const session = await stripe.checkout.sessions.create({
          line_items: [
            {
              price_data: {
                currency: "USD",
                unit_amount: amount,
                product_data: {
                  name: paymentInfo.parcelName,
                },
              },
              quantity: 1,
            },
          ],
          customer_email: paymentInfo.senderEmail,
          metadata: {
            parcelId: paymentInfo.parcelId,
            parcelName: paymentInfo.parcelName,
          },
          mode: "payment",
          success_url: `${process.env.SITE_DOMAIN}dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${process.env.SITE_DOMAIN}dashboard/payment-cancelled`,
        });

        res.send({ url: session.url });
      } catch (error) {
        console.log(error);
        res.status(400).send({ error: error.message });
      }
    });

    // ===========================
    // PAYMENT SUCCESS
    // ===========================
    // app.patch("/payment-success", async (req, res) => {
    //   const sessionId = req.query.session_id;

    //   try {
    //     const session = await stripe.checkout.sessions.retrieve(sessionId);

    //     if (session.payment_status === "paid") {
    //       const parcelId = session.metadata.parcelId;

    //       const trackingId = generateTrackingIdSecure();

    //       logTracking(trackingId, "pending-pickup");
    //       const update = {
    //         $set: {
    //           paymentStatus: "Paid",
    //           trackingId: trackingId,
    //           deliveryStatus: "pending-pickup",
    //         },
    //       };
    //       // Log Tracking function

    //       const transactionId = session.payment_intent;
    //       const query = { transactionId: transactionId };
    //       const paymentExist = await paymentCollection.findOne(query);

    //       if (paymentExist) {
    //         return res.send({ message: "already exist" });
    //       }

    //       const modifyParcel = await parcelsCollection.updateOne(
    //         { _id: new ObjectId(parcelId) },
    //         update
    //       );

    //       const paymentRecord = {
    //         amount: session.amount_total / 100,
    //         transactionId: session.payment_intent,
    //         currency: session.currency,
    //         customerEmail: session.customer_email,
    //         parcelName: session.metadata.parcelName,
    //         paymentStatus: session.payment_status,
    //         paidAt: new Date(),
    //         trackingId: trackingId,
    //       };

    //       const savePayment = await paymentCollection.insertOne(paymentRecord);

    //       return res.send({
    //         success: true,
    //         transactionId: session.payment_intent,
    //         trackingId,
    //         modifyParcel,
    //         paymentRecord: savePayment,
    //       });
    //     }

    //     res.status(400).send({ error: "Payment not completed" });
    //   } catch (err) {
    //     console.log(err);
    //     res.status(500).send({ error: "Payment processing failed" });
    //   }
    // });
    // app.patch("/payment-success", async (req, res) => {
    //   const sessionId = req.query.session_id;

    //   try {
    //     const session = await stripe.checkout.sessions.retrieve(sessionId);

    //     if (session.payment_status !== "paid") {
    //       return res.status(400).send({ error: "Payment not completed" });
    //     }

    //     const parcelId = session.metadata.parcelId;

    //     // ✅ Generate trackingId only once
    //     const trackingId = generateTrackingIdSecure();

    //     // Check if payment already exists
    //     const transactionId = session.payment_intent;
    //     const paymentExist = await paymentCollection.findOne({ transactionId });
    //     if (paymentExist) {
    //       return res.send({
    //         message: "Payment already exists",
    //         trackingId: paymentExist.trackingId,
    //       });
    //     }

    //     // Log tracking once
    //     await trackingCollection.insertOne({
    //       status: "pending-pickup",
    //       trackingId,
    //       details: "pending pickup",
    //       createdAt: new Date(),
    //       parcelId,
    //     });

    //     // Update parcel with trackingId and paymentStatus
    //     await parcelsCollection.updateOne(
    //       { _id: new ObjectId(parcelId) },
    //       {
    //         $set: {
    //           paymentStatus: "Paid",
    //           trackingId,
    //           deliveryStatus: "pending-pickup",
    //         },
    //       }
    //     );

    //     // Save payment record
    //     const paymentRecord = {
    //       amount: session.amount_total / 100,
    //       transactionId: session.payment_intent,
    //       currency: session.currency,
    //       customerEmail: session.customer_email,
    //       parcelName: session.metadata.parcelName,
    //       paymentStatus: session.payment_status,
    //       paidAt: new Date(),
    //       trackingId,
    //     };

    //     await paymentCollection.insertOne(paymentRecord);

    //     res.send({
    //       success: true,
    //       trackingId,
    //       paymentRecord,
    //     });
    //   } catch (err) {
    //     console.log(err);
    //     res.status(500).send({ error: "Payment processing failed" });
    //   }
    // });
    // =========================
// PAYMENT SUCCESS (CLEAN)
// =========================

// app.patch("/payment-success", async (req, res) => {
  app.patch('/payment-success',async(req,res)=>{
    
 
  const sessionId = req.query.session_id;

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (session.payment_status !== "paid") {
      return res.status(400).send({ error: "Payment not completed" });
    }

    const parcelId = session.metadata.parcelId;

    // ================================
    // 1️⃣ FIND THE PARCEL FIRST
    // ================================
    const parcel = await parcelsCollection.findOne({
      _id: new ObjectId(parcelId),
    });

    if (!parcel) {
      return res.status(404).send({ error: "Parcel not found" });
    }

    // ==================================
    // 2️⃣ USE EXISTING TRACKING ID
    // ==================================
    let trackingId = parcel.trackingId;

    // If trackingId doesn't exist → generate once
    if (!trackingId) {
      trackingId = generateTrackingIdSecure();

      await parcelsCollection.updateOne(
        { _id: new ObjectId(parcelId) },
        { $set: { trackingId } }
      );
    }

    // ==================================
    // 3️⃣ CHECK IF PAYMENT ALREADY EXISTS
    // ==================================
    const transactionId = session.payment_intent;
    const existingPayment = await paymentCollection.findOne({ transactionId });

    if (existingPayment) {
      return res.send({
        message: "Payment already exists",
        trackingId,
      });
    }

    // ==================================
    // 4️⃣ CALL logTracking WITH EXISTING ID
    // ==================================
    await logTracking(trackingId, "payment successful");

    // ==================================
    // 5️⃣ UPDATE PARCEL PAYMENT STATUS
    // ==================================
    await parcelsCollection.updateOne(
      { _id: new ObjectId(parcelId) },
      {
        $set: {
          paymentStatus: "Paid",
          deliveryStatus: "pending-pickup",
        },
      }
    );

    // ==================================
    // 6️⃣ SAVE PAYMENT RECORD
    // ==================================
    const paymentRecord = {
      amount: session.amount_total / 100,
      transactionId: session.payment_intent,
      currency: session.currency,
      customerEmail: session.customer_email,
      parcelName: session.metadata.parcelName,
      paymentStatus: session.payment_status,
      paidAt: new Date(),
      trackingId: trackingId,
    };

    await paymentCollection.insertOne(paymentRecord);

    return res.send({
      success: true,
      trackingId,
      paymentRecord,
    });
  } catch (err) {
    console.log(err);
    return res.status(500).send({ error: "Payment processing failed" });
  }
});


    // =================
    // Payment History
    // =================
    app.get("/payments", async (req, res) => {
      const email = req.query.email;
      const query = {};

      if (email) {
        query.customerEmail = email;

        // FIXED: check email correctly
        if (email !== req.decode_email) {
          return res.status(403).send({ message: "Forbidden access" });
        }
      }

      const cursor = paymentCollection.find(query);
      const result = await cursor.toArray();
      res.send(result);
    });

    // =====================
    // CRUD: PARCELS
    // =====================
    app.get("/parcelsDelivered", async (req, res) => {
      const { email, deliveryStatus } = req.query;
      console.log(email, deliveryStatus);

      const query = {
        deliveryStatus: deliveryStatus,
        riderEmail: email,
      };
      const result = await parcelsCollection.find(query).toArray();
      res.send(result);
    });
    app.patch("/parcels/:id/status", async (req, res) => {
      const filter = { _id: new ObjectId(req.params.id) };
      const { trackingId,deliveryStatus, riderId } = req.body;
      const updateDoc = {
        $set: {
          deliveryStatus: deliveryStatus,
        },
      };
      logTracking(trackingId,deliveryStatus)
      const result = await parcelsCollection.updateOne(filter, updateDoc);
      if (deliveryStatus === "delivered") {
        const query = { _id: new ObjectId(riderId) };
        const updateDoc = {
          $set: {
            workStatus: "available",
          },
        };
        const riderWorkStatusUpdate = await ridersCollection.updateOne(
          query,
          updateDoc
        );
        res.send(riderWorkStatusUpdate);
      }
      res.send(result);
    });
    app.patch("/parcels/:id", async (req, res) => {
      const { trackingId, parcelId, riderId, riderName, riderEmail } = req.body;
      console.log(req.query);

      const filter = { _id: new ObjectId(parcelId) };
      const updateDoc = {
        $set: {
          deliveryStatus: "delivery-assigned",
          riderId: riderId,
          riderName: riderName,
          riderEmail: riderEmail,
        },
      };
      const result = await parcelsCollection.updateOne(filter, updateDoc);
      const filterRider = { _id: new ObjectId(riderId) };
      const updateRiderDoc = {
        $set: {
          workStatus: "in_delivery",
        },
      };
      const riderResult = await ridersCollection.updateOne(
        filterRider,
        updateRiderDoc
      );
      // log Tracking
      logTracking(trackingId, "Driver-assigned");
      res.send(riderResult);
    });
    app.post("/parcels", async (req, res) => {
      const parcel = req.body;
      parcel.createdAt = new Date();
      const result = await parcelsCollection.insertOne(parcel);
      const trackingId = generateTrackingIdSecure();
      logTracking(trackingId, "parcelCreated");
      res.send(result);
    });
    // app.get('/parcels/')

    app.get("/parcels", async (req, res) => {
      const query = {};

      const { deliveryStatus } = req.query;
      if (deliveryStatus) {
        query.deliveryStatus = deliveryStatus;
      }
      const { email } = req.query;

      if (email) query.senderEmail = email;

      const results = await parcelsCollection
        .find(query)
        .sort({ createdAt: -1 })
        .toArray();

      res.send(results);
    });
  app.get("/parcels/rider", async (req, res) => {
  const { riderEmail, deliveryStatus } = req.query;

  const query = {};

  if (riderEmail) {
    query.riderEmail = riderEmail;
  }

  if (deliveryStatus) {
    query.deliveryStatus = { $nin: ["delivered"] };
  }

  // এখন result পাঠানো হচ্ছে
  const result = await parcelsCollection.find(query).toArray();
  res.send(result);
});

    app.get("/parcels/:id", async (req, res) => {
      const id = req.params.id;
      const result = await parcelsCollection.findOne({
        _id: new ObjectId(id),
      });
      res.send(result);
    });

    app.delete("/parcels/:id", async (req, res) => {
      const id = req.params.id;
      const result = await parcelsCollection.deleteOne({
        _id: new ObjectId(id),
      });
      res.send(result);
    });

    // Tracking realted api
    app.get('/trackings/:trackingId',async(req,res)=>{
      const trackingId=req.params.trackingId
      const filter={trackingId}
      const result=await trackingCollection.find(filter).toArray()
      res.send(result)
    })
  } finally {
    // Do not close client if using continuous server
  }
}

run().catch(console.dir);

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
