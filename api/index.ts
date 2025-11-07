// backend/api/index.ts

import express, {
  Request as ExpressRequest,
  Response,
  NextFunction,
} from "express";
import cors from "cors";
import admin from "firebase-admin";
import path from "path";
import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";
import { SchemaType } from "@google/generative-ai";

dotenv.config();

const serviceAccountPath = path.resolve(__dirname, "../serviceAccountKey.json");
const app = express();
app.use(cors());
app.use(express.json());
app.get("/", (req, res) => {
  res.send("✅ mentor assistant backend is running!");
});

// Initialize Firebase Admin
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    }),
  });
}

const db = admin.firestore();
// auth

interface AuthRequest extends ExpressRequest {
  user?: admin.auth.DecodedIdToken;
}
const verifyToken = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  // This will now work perfectly
  const authHeader = req.header("Authorization");

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).send({ error: "Unauthorized: No token provided." });
  }
  const idToken = authHeader.split("Bearer ")[1];
  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    req.user = decodedToken;
    next();
  } catch (error) {
    console.error("Error verifying token:", error);
    return res.status(403).send({ error: "Forbidden: Invalid token." });
  }
};
//

const ai = new GoogleGenAI({ apiKey: process.env.GEMENI_API_KEY });
app.get("/test-ai", async (req, res) => {
  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: "Explain how AI works in a few words",
  });
  console.log(response.text);
  res.json({ message: response.text });
});

app.get(
  "/summary/:mentorId/:tutorId",
  verifyToken,
  async (req: AuthRequest, res: Response) => {
    try {
      const { mentorId, tutorId } = req.params;

      if (req.user?.uid !== mentorId) {
        return res
          .status(403)
          .json({ error: "Forbidden: You can only access your own data." });
      }

      const incidentsRef = db
        .collection("mentors")
        .doc(mentorId)
        .collection("tutors")
        .doc(tutorId)
        .collection("incidents");

      const snapshot = await incidentsRef.get();
      if (snapshot.empty) {
        // Send back the full, empty JSON structure
        return res.json({
          summary: "No incidents to summarize yet.",
          patterns: [],
          suggestions: [],
        });
      }

      const incidentTexts = snapshot.docs.map((doc) => {
        const data = doc.data();
        const date = data.date?.toDate().toISOString() ?? "unknown date";
        return `${date}: ${data.description}`;
      });

      // 1. Define the Schema using SchemaType
      const jsonSchema = {
        type: SchemaType.OBJECT,
        properties: {
          summary: { type: SchemaType.STRING },
          patterns: {
            type: SchemaType.ARRAY,
            items: { type: SchemaType.STRING },
          },
          suggestions: {
            type: SchemaType.ARRAY,
            items: { type: SchemaType.STRING },
          },
        },
        required: ["summary", "patterns", "suggestions"],
      };

      // 2. Define the strict prompt
      const prompt = `
You are an educational performance assistant. Your task is to analyze a list of incidents for a tutor and provide a holistic performance summary.
Analyze ALL incidents AS A WHOLE. You MUST NOT summarize each incident individually.
Respond ONLY with a JSON object matching this schema:
{
  "summary": "A 2-3 sentence overall summary of performance.",
  "patterns": ["A list of key behavioral patterns (strengths or weaknesses)."],
  "suggestions": ["A list of actionable suggestions for improvement (if any)."]
}
Here are the incidents:
${incidentTexts.join("\n")}
`;

      // 3. Create the request object (no 'GenerateContentRequest' type)
      const genAIRequest = {
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: jsonSchema,
        },
      };

      // 4. Call the AI
      const result = await ai.models.generateContent({
        model: "gemini-2.5-flash", // Use a stable model
        ...genAIRequest,
      });

      console.log("finding summary:...");

      // 5. Safely get and parse the text
      const jsonString = result.text;
      if (!jsonString) {
        throw new Error("No text response from AI.");
      }

      const startIndex = jsonString.indexOf("{");
      const endIndex = jsonString.lastIndexOf("}");

      if (startIndex === -1 || endIndex === -1) {
        throw new Error("AI response did not contain valid JSON.");
      }

      // Extract the clean JSON string
      const extractedJson = jsonString.substring(startIndex, endIndex + 1);

      // Now, parse the *clean* string
      const summaryJson = JSON.parse(extractedJson);
      console.log(summaryJson);
      res.json(summaryJson); // Send the full object to the frontend
    } catch (error) {
      console.error("Error in /summary route:", error);
      res.status(500).json({ message: "Something wrong happened" });
    }
  }
);
app.post("/test", (req, res) => {
  console.log("received:", req.body);
  res.json({ message: "data received successfully" });
});

app.get("/test-db", async (req, res) => {
  const docRef = db.collection("debug").doc("ping");
  await docRef.set({ time: new Date().toISOString() });
  res.send("🔥 Firestore test write done!");
});

export default app;