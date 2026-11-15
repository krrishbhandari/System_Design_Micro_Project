import express from "express";
import { handleSync, getRules, getStatus } from "../controllers/sync.controller.js";

const router = express.Router();

router.post("/sync", handleSync);
router.get("/rules", getRules);
router.get("/status", getStatus);

export default router;
