import mongoose from 'mongoose';

const debtSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: ['owe', 'owed'], required: true },
    person: { type: String, required: true },
    amount: { type: Number, required: true },
    note: { type: String, default: '' },
    isSettled: { type: Boolean, default: false },
    creationTxId: { type: String, default: null },
    settlementTxId: { type: String, default: null },
    date: { type: Date, required: true, default: Date.now }
}, { timestamps: true });

export default mongoose.model('Debt', debtSchema);
