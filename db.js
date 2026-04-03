import 'dotenv/config';
import mongoose from 'mongoose';

const MONGO_URI = process.env.MONGO_URI;

export async function connectDB() {
    try {
        await mongoose.connect(MONGO_URI, {
            dbName: 'vault_flow'
        });
        console.log(`  ✅ MongoDB connected: ${mongoose.connection.host}/${mongoose.connection.name}`);
    } catch (err) {
        console.error('  ❌ MongoDB connection failed:', err.message);
        process.exit(1);
    }
}

export default mongoose;
