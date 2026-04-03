import mongoose from 'mongoose';

const incomeSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    amount: { type: Number, required: true },
    category: { type: String, required: true },
    subcategory: { type: String, default: '' },
    note: { type: String, default: '' },
    date: { type: Date, required: true, default: Date.now },
    debtId: { type: mongoose.Schema.Types.ObjectId, ref: 'Debt', default: null }
}, { timestamps: true });

export default mongoose.model('Income', incomeSchema);
