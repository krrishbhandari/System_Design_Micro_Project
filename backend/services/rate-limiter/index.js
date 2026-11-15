import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import connectDb from "./config/db.js";
import syncRoutes from "./routes/sync.route.js";
import { seedDefaultRulesIfEmpty } from "./services/leaseAllocator.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, ".env") });

const port = process.env.PORT || 8005;
const app = express();

app.use(cors());
app.use(express.json());

app.use("/api/rate-limit", syncRoutes);

app.get("/", (req, res) => {
  res.send("Hello from Rate Limiter Coordinator Service!");
});

app.listen(port, async () => {
  console.log(`Rate Limiter Coordinator Service is running on port ${port}`);
  await connectDb();
  await seedDefaultRulesIfEmpty();
});
