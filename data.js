import Expense from './models/Expense.js';
import Income from './models/Income.js';
import User from './models/User.js';
import Debt from './models/Debt.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET;

/**
 * Helper: format a Mongoose doc to the shape the frontend expects.
 */
function formatTx(doc, type) {
    return {
        id: doc._id.toString(),
        type,
        amount: doc.amount,
        category: doc.category,
        subcategory: doc.subcategory,
        note: doc.note,
        date: doc.date.toISOString(),
    };
}

// ─── Authentication ───────────────────────────────────────

export async function registerUser({ name, email, password }) {
    // Check if user exists
    const existing = await User.findOne({ email });
    if (existing) throw new Error('User already exists');

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create user
    const user = await User.create({ name, email, password: hashedPassword });

    // Create token
    const token = jwt.sign({ userId: user._id }, JWT_SECRET, { expiresIn: '7d' });

    return {
        token,
        user: { id: user._id, name: user.name, email: user.email }
    };
}

export async function loginUser({ email, password }) {
    // Find user
    const user = await User.findOne({ email });
    if (!user) throw new Error('Invalid credentials');

    // Check password
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) throw new Error('Invalid credentials');

    // Create token
    const token = jwt.sign({ userId: user._id }, JWT_SECRET, { expiresIn: '7d' });

    return {
        token,
        user: { id: user._id, name: user.name, email: user.email }
    };
}

export async function getMe(userId) {
    const user = await User.findById(userId).select('-password');
    if (!user) throw new Error('User not found');
    return { id: user._id, name: user.name, email: user.email, avatar: user.avatar };
}

export async function updateAvatar(userId, avatarPath) {
    const user = await User.findByIdAndUpdate(userId, { avatar: avatarPath }, { new: true });
    if (!user) throw new Error('User not found');
    return { id: user._id, name: user.name, email: user.email, avatar: user.avatar };
}

// ─── Transactions ────────────────────────────────────────

export async function getTransactions(userId) {
    const [expenses, incomes] = await Promise.all([
        Expense.find({ userId }).sort({ date: -1 }).lean(),
        Income.find({ userId }).sort({ date: -1 }).lean(),
    ]);

    const all = [
        ...expenses.map(e => formatTx(e, 'expense')),
        ...incomes.map(i => formatTx(i, 'income')),
    ];

    all.sort((a, b) => new Date(b.date) - new Date(a.date));
    return all;
}

export async function addTransaction(userId, data) {
    const doc = {
        userId,
        amount: data.amount,
        category: data.category,
        subcategory: data.subcategory || '',
        note: data.note || '',
        date: data.date ? new Date(data.date) : new Date(),
        debtId: data.debtId || null,
    };

    if (data.type === 'income') {
        const saved = await Income.create(doc);
        return formatTx(saved, 'income');
    } else {
        const saved = await Expense.create(doc);
        return formatTx(saved, 'expense');
    }
}

export async function deleteTransaction(userId, id) {
    // Try both collections but ensure ownership
    let result = await Expense.findOneAndDelete({ _id: id, userId });
    if (!result) result = await Income.findOneAndDelete({ _id: id, userId });
    if (!result) return null;
    return { success: true };
}

export async function updateTransaction(userId, id, data) {
    const update = {};
    if (data.amount !== undefined) update.amount = data.amount;
    if (data.category !== undefined) update.category = data.category;
    if (data.subcategory !== undefined) update.subcategory = data.subcategory;
    if (data.note !== undefined) update.note = data.note;
    if (data.date !== undefined) update.date = new Date(data.date);

    // Try expense first
    let doc = await Expense.findOneAndUpdate({ _id: id, userId }, update, { new: true });
    if (doc) return formatTx(doc, 'expense');

    // Try income
    doc = await Income.findOneAndUpdate({ _id: id, userId }, update, { new: true });
    if (doc) return formatTx(doc, 'income');

    // Handle type change: if the type changed, we need to move the document
    if (data.type) {
        const expenseDoc = await Expense.findOne({ _id: id, userId });
        const incomeDoc = await Income.findOne({ _id: id, userId });

        if (expenseDoc && data.type === 'income') {
            await Expense.findOneAndDelete({ _id: id, userId });
            const newDoc = await Income.create({ ...expenseDoc.toObject(), ...update, _id: undefined, userId });
            return formatTx(newDoc, 'income');
        }
        if (incomeDoc && data.type === 'expense') {
            await Income.findOneAndDelete({ _id: id, userId });
            const newDoc = await Expense.create({ ...incomeDoc.toObject(), ...update, _id: undefined, userId });
            return formatTx(newDoc, 'expense');
        }
    }

    return null;
}

// ─── Dashboard Stats ──────────────────────────────────────

export async function getDashboardStats(userId) {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

    const [expenseDocs, incomeDocs] = await Promise.all([
        Expense.find({ userId, date: { $gte: monthStart, $lte: monthEnd } }).lean(),
        Income.find({ userId, date: { $gte: monthStart, $lte: monthEnd } }).lean(),
    ]);

    // Calculate income breakdown:
    // TotalIncome shows: All regular income + Income from OLD debt settlements.
    // Income from THIS month's debt settlements is EXCLUDED from TotalIncome but INCLUDED in TotalBalance.
    
    // Fetch all debts linked to these income docs to check their creation date
    const debtIds = incomeDocs.filter(i => i.debtId).map(i => i.debtId);
    const relatedDebts = await Debt.find({ _id: { $in: debtIds } }).lean();
    const debtMap = Object.fromEntries(relatedDebts.map(d => [d._id.toString(), d]));

    let displayIncome = 0;
    let balanceOnlyIncome = 0;

    incomeDocs.forEach(tx => {
        if (tx.category === 'Debt settlement' && tx.debtId) {
            const debt = debtMap[tx.debtId.toString()];
            if (debt) {
                const debtDate = new Date(debt.date);
                const isDebtFromCurrentMonth = debtDate.getFullYear() === now.getFullYear() && debtDate.getMonth() === now.getMonth();
                
                if (isDebtFromCurrentMonth) {
                    balanceOnlyIncome += tx.amount;
                } else {
                    displayIncome += tx.amount;
                }
            } else {
                displayIncome += tx.amount;
            }
        } else {
            displayIncome += tx.amount;
        }
    });

    const totalExpenses = expenseDocs.reduce((sum, t) => sum + t.amount, 0);

    // Daily activity (for the chart)
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const dailyMap = {};
    for (let i = 1; i <= daysInMonth; i++) {
        dailyMap[i.toString()] = { income: 0, expense: 0 };
    }

    incomeDocs.forEach(tx => {
        const day = new Date(tx.date).getDate().toString();
        if (dailyMap[day]) dailyMap[day].income += tx.amount;
    });
    expenseDocs.forEach(tx => {
        const day = new Date(tx.date).getDate().toString();
        if (dailyMap[day]) dailyMap[day].expense += tx.amount;
    });

    const dailyExpenses = Array.from({ length: daysInMonth }, (_, i) => ({
        day: (i + 1).toString(),
        income: dailyMap[(i + 1).toString()].income,
        expense: dailyMap[(i + 1).toString()].expense,
    }));

    const historicalSavingsData = await getSavings(userId);

    return {
        totalBalance: displayIncome + balanceOnlyIncome - totalExpenses,
        totalIncome: displayIncome,
        totalExpenses,
        totalSavings: historicalSavingsData.totalSavings,
        dailyExpenses,
    };
}

// ─── Bank Accounts (static) ──────────────────────────────

export function getBankAccounts() {
    return [
        { id: 1, name: 'Brac Bank', balance: 23400, lastSynced: '2 min ago', color: '#135BAA' },
        { id: 2, name: 'Dutch Bangla', balance: 12040, lastSynced: '10 min ago', color: '#D71E28' },
    ];
}

// ─── Statistics ──────────────────────────────────────────

export async function getStatistics(userId, params = {}) {
    const { month, year } = params;
    const now = new Date();

    // --- Build date filter ---
    let dateFilter = { userId };
    if (month) {
        // month format: "YYYY-MM"
        const [y, m] = month.split('-').map(Number);
        dateFilter.date = {
            $gte: new Date(y, m - 1, 1),
            $lte: new Date(y, m, 0, 23, 59, 59, 999),
        };
    } else if (year) {
        dateFilter.date = {
            $gte: new Date(Number(year), 0, 1),
            $lte: new Date(Number(year), 11, 31, 23, 59, 59, 999),
        };
    }

    const [expenseTxs, incomeTxs] = await Promise.all([
        Expense.find(dateFilter).lean(),
        Income.find(dateFilter).lean(),
    ]);

    // --- Pie data ---
    const categoryColors = {
        Food: '#F59E0B', Clothes: '#EC4899', Transport: '#3B82F6',
        Rent: '#8B5CF6', Gadgets: '#10B981', Others: '#64748B',
    };

    const categoryMap = {};
    expenseTxs.forEach(tx => {
        if (!categoryMap[tx.category]) categoryMap[tx.category] = 0;
        categoryMap[tx.category] += tx.amount;
    });

    const pieData = Object.entries(categoryMap).map(([name, value]) => ({
        name, value, color: categoryColors[name] || '#94A3B8',
    }));

    const totalSpending = expenseTxs.reduce((sum, t) => sum + t.amount, 0);

    // Filter income transactions for statistics summary to exclude internal transfers 
    // such as Savings withdrawals and same-month Debt settlements.
    const debtIds = incomeTxs.filter(i => i.debtId).map(i => i.debtId);
    const relatedDebts = await Debt.find({ _id: { $in: debtIds } }).lean();
    const debtMap = Object.fromEntries(relatedDebts.map(d => [d._id.toString(), d]));

    let totalIncome = 0;
    incomeTxs.forEach(tx => {
        // For Debt settlements, only count those where the debt was created before the current period (simplified)
        if (tx.category === 'Debt settlement' && tx.debtId) {
            const debt = debtMap[tx.debtId.toString()];
            if (debt) {
                const txDate = new Date(tx.date);
                const debtDate = new Date(debt.date);
                // Exclude if debt was created in the same month as this settlement 
                // (this avoids double counting if money was lent and returned in the same period)
                if (debtDate.getMonth() === txDate.getMonth() && debtDate.getFullYear() === txDate.getFullYear()) {
                    return;
                }
            }
        }
        totalIncome += tx.amount;
    });

    // --- Area data (last 6 months, always from ALL data) ---
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const areaData = [];
    for (let i = 5; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const mStart = new Date(d.getFullYear(), d.getMonth(), 1);
        const mEnd = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);

        const [mExpDocs, mIncDocs] = await Promise.all([
            Expense.find({ userId, date: { $gte: mStart, $lte: mEnd } }).lean(),
            Income.find({ userId, date: { $gte: mStart, $lte: mEnd } }).lean(),
        ]);

        areaData.push({
            name: monthNames[d.getMonth()],
            income: mIncDocs.reduce((s, t) => s + t.amount, 0),
            expense: mExpDocs.reduce((s, t) => s + t.amount, 0),
        });
    }

    // --- Bar Chart (Daily or Monthly) ---
    let dailyExpenses = [];
    const allFiltered = [
        ...expenseTxs.map(e => ({ ...e, type: 'expense' })),
        ...incomeTxs.map(i => ({ ...i, type: 'income' })),
    ];

    if (year && !month) {
        // Yearly mode: group by month
        const monthlyMap = {};
        allFiltered.forEach(tx => {
            const m = new Date(tx.date).getMonth();
            const monthName = monthNames[m];
            if (!monthlyMap[monthName]) monthlyMap[monthName] = { income: 0, expense: 0 };
            if (tx.type === 'income') monthlyMap[monthName].income += tx.amount;
            else monthlyMap[monthName].expense += tx.amount;
        });

        dailyExpenses = monthNames.map(m => ({
            month: m,
            income: monthlyMap[m]?.income || 0,
            expense: monthlyMap[m]?.expense || 0,
            amount: monthlyMap[m]?.expense || 0,
        }));
    } else {
        // Monthly mode: group by day
        const daysCount = month
            ? new Date(parseInt(month.split('-')[0]), parseInt(month.split('-')[1]), 0).getDate()
            : 30;

        const dailyMap = {};
        for (let i = 1; i <= daysCount; i++) {
            dailyMap[i.toString()] = { income: 0, expense: 0 };
        }

        allFiltered.forEach(tx => {
            const day = new Date(tx.date).getDate().toString();
            if (dailyMap[day]) {
                if (tx.type === 'income') dailyMap[day].income += tx.amount;
                else dailyMap[day].expense += tx.amount;
            }
        });

        dailyExpenses = Array.from({ length: daysCount }, (_, i) => ({
            day: (i + 1).toString(),
            income: dailyMap[(i + 1).toString()].income,
            expense: dailyMap[(i + 1).toString()].expense,
            amount: dailyMap[(i + 1).toString()].expense,
        }));
    }

    return {
        pieData,
        areaData,
        totalSpending,
        totalExpenses: totalSpending,
        totalIncome,
        dailyExpenses,
    };
}

// ─── Savings ──────────────────────────────────────────────

export async function getSavings(userId) {
    const now = new Date();
    // Get beginning of current month
    const startOfCurrentMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    // Fetch all transactions before current month
    const [expenses, incomes] = await Promise.all([
        Expense.find({ userId, date: { $lt: startOfCurrentMonth } }).lean(),
        Income.find({ userId, date: { $lt: startOfCurrentMonth } }).lean(),
    ]);

    const monthMap = {}; // { 'YYYY-MM': { income: 0, expense: 0 } }

    const processTx = (tx, type) => {
        // Skip Savings withdrawal transactions for regular monthly income/expense calculation
        if (type === 'income' && tx.category === 'Savings') return;

        const d = new Date(tx.date);
        const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        if (!monthMap[monthKey]) {
            monthMap[monthKey] = { income: 0, expense: 0 };
        }
        if (type === 'income') {
            monthMap[monthKey].income += tx.amount;
        } else {
            monthMap[monthKey].expense += tx.amount;
        }
    };

    expenses.forEach(e => processTx(e, 'expense'));
    incomes.forEach(i => processTx(i, 'income'));

    const monthlySavings = Object.keys(monthMap).map(monthStr => {
        const data = monthMap[monthStr];
        return {
            month: monthStr,
            income: data.income,
            expense: data.expense,
            savings: data.income - data.expense
        };
    });

    // Sort descending by month
    monthlySavings.sort((a, b) => b.month.localeCompare(a.month));

    const grossHistoricalSavings = monthlySavings.reduce((sum, m) => sum + m.savings, 0);

    // Sum all "Savings" withdrawals across all months (including current)
    const allSavingsWithdrawals = await Income.find({ userId, category: 'Savings' }).lean();
    const totalWithdrawals = allSavingsWithdrawals.reduce((sum, tx) => sum + tx.amount, 0);

    return {
        totalSavings: grossHistoricalSavings - totalWithdrawals,
        history: monthlySavings,
        withdrawals: allSavingsWithdrawals.map(w => ({
            id: w._id.toString(),
            amount: w.amount,
            date: w.date.toISOString(),
            note: w.note || 'Withdrawal'
        })).sort((a, b) => b.date.localeCompare(a.date))
    };
}

// ─── Debts ──────────────────────────────────────────────

export async function getDebts(userId) {
    const debts = await Debt.find({ userId }).sort({ date: -1 }).lean();
    return debts.map(d => ({
        id: d._id.toString(),
        type: d.type,
        person: d.person,
        amount: d.amount,
        note: d.note,
        isSettled: d.isSettled,
        date: d.date.toISOString(),
        createdAt: d.createdAt.toISOString()
    }));
}

export async function addDebt(userId, data) {
    const doc = {
        userId,
        type: data.type,
        person: data.person,
        amount: Number(data.amount),
        note: data.note || '',
        isSettled: Boolean(data.isSettled),
        date: data.date ? new Date(data.date) : new Date(),
    };

    const saved = await Debt.create(doc);
    return {
        id: saved._id.toString(),
        type: saved.type,
        person: saved.person,
        amount: saved.amount,
        note: saved.note,
        isSettled: saved.isSettled,
        date: saved.date.toISOString(),
        createdAt: saved.createdAt.toISOString()
    };
}

export async function updateDebt(userId, id, data) {
    const existing = await Debt.findOne({ _id: id, userId });
    if (!existing) return null;

    const update = {};
    if (data.type !== undefined) update.type = data.type;
    if (data.person !== undefined) update.person = data.person;
    if (data.amount !== undefined) update.amount = Number(data.amount);
    if (data.note !== undefined) update.note = data.note;
    if (data.isSettled !== undefined) update.isSettled = Boolean(data.isSettled);
    if (data.date !== undefined) update.date = new Date(data.date);

    // Partial Payment Logic
    if (data.paidAmount !== undefined && Number(data.paidAmount) > 0) {
        const paidAmount = Number(data.paidAmount);
        
        // Ensure paidAmount doesn't exceed current amount
        const currentAmount = existing.amount;
        const finalPaidAmount = Math.min(paidAmount, currentAmount);

        // Transaction logic (Same as full settlement)
        const debtDate = new Date(existing.date);
        const now = new Date();
        const isCurrentMonth = debtDate.getFullYear() === now.getFullYear() && debtDate.getMonth() === now.getMonth();

        const txData = {
            type: existing.type === 'owe' ? 'expense' : 'income',
            amount: finalPaidAmount,
            category: 'Debt settlement',
            subcategory: existing.type === 'owe' ? 'Paid' : 'Received',
            note: `Partial payment: ${existing.person}`,
            date: new Date(),
            debtId: existing._id
        };
        const newTx = await addTransaction(userId, txData);

        // Update the debt amount
        update.amount = currentAmount - finalPaidAmount;
        if (update.amount <= 0) {
            update.isSettled = true;
            if (newTx && newTx.id) {
                update.settlementTxId = newTx.id;
            }
        }
    }

    // Full Settlement Logic (Toggle)
    else if (update.isSettled === true && !existing.isSettled) {
        const debtDate = new Date(existing.date);
        const now = new Date();
        const isCurrentMonth = debtDate.getFullYear() === now.getFullYear() && debtDate.getMonth() === now.getMonth();

        const txData = {
            type: existing.type === 'owe' ? 'expense' : 'income',
            amount: existing.amount,
            category: 'Debt settlement',
            subcategory: existing.type === 'owe' ? 'Paid' : 'Received',
            note: `Debt settled: ${existing.person}`,
            date: new Date(),
            debtId: existing._id
        };
        const newTx = await addTransaction(userId, txData);
        if (newTx && newTx.id) {
            update.settlementTxId = newTx.id;
        }
    }

    // Full Settlement Logic (Undo)
    else if (update.isSettled === false && existing.isSettled) {
        if (existing.settlementTxId) {
            await deleteTransaction(userId, existing.settlementTxId);
            update.settlementTxId = null;
        }
    }

    const doc = await Debt.findOneAndUpdate({ _id: id, userId }, update, { new: true });
    if (!doc) return null;
    return {
        id: doc._id.toString(),
        type: doc.type,
        person: doc.person,
        amount: doc.amount,
        note: doc.note,
        isSettled: doc.isSettled,
        date: doc.date.toISOString(),
        createdAt: doc.createdAt.toISOString()
    };
}

export async function deleteDebt(userId, id) {
    const existing = await Debt.findOne({ _id: id, userId });
    if (!existing) return null;

    // Cleanup transactions
    if (existing.creationTxId) {
        await deleteTransaction(userId, existing.creationTxId);
    }
    if (existing.settlementTxId) {
        await deleteTransaction(userId, existing.settlementTxId);
    }

    await Debt.findOneAndDelete({ _id: id, userId });
    return { success: true };
}
