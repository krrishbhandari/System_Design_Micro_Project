import mongoose from "mongoose";

const connectDb = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGODB_URI);
    console.log(`Rate Limiter Coordinator DB connected: ${conn.connection.host}`);
  } catch (error) {
    console.error("Rate Limiter MongoDB connection error:", error);
    process.exit(1);
  }
};

export default connectDb;
