import 'dotenv/config';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { formidable } from 'formidable';
import jwt from 'jsonwebtoken';
import { fileURLToPath } from 'node:url';
import { connectDB } from './db.js';
import {
    getTransactions,
    addTransaction,
    deleteTransaction,
    getDashboardStats,
    getBankAccounts,
    getStatistics,
    updateTransaction,
    registerUser,
    loginUser,
    getMe,
    updateAvatar,
    getDebts,
    addDebt,
    updateDebt,
    deleteDebt,
    getSavings
} from './data.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'your_super_secret_key_123';

/**
 * Parse JSON body from incoming request.
 */
function parseBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => (body += chunk));
        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch (err) {
                reject(new Error('Invalid JSON body'));
            }
        });
        req.on('error', reject);
    });
}

/**
 * Send a JSON response.
 */
function sendJSON(res, statusCode, data) {
    res.writeHead(statusCode, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    res.end(JSON.stringify(data));
}

/**
 * Middleware: Verify JWT and return userId.
 */
async function authenticate(req, res) {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        sendJSON(res, 401, { message: 'Unauthorized: No token provided' });
        return null;
    }

    const token = authHeader.split(' ')[1];
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        return decoded.userId;
    } catch (err) {
        sendJSON(res, 401, { message: 'Unauthorized: Invalid token' });
        return null;
    }
}

/**
 * Main request handler — routes requests to the appropriate data function.
 */
async function handleRequest(req, res) {
    const { method } = req;
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const pathname = url.pathname;

    // Handle CORS preflight
    if (method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        });
        return res.end();
    }

    try {
        // Normalize pathname: remove trailing slash and double slashes
        const normalizedPath = pathname.replace(/\/+$/, '') || '/';
        
        console.log(`[${method}] ${normalizedPath}`);

        // ---------- Auth Routes (Public) ----------
        // Allow both with and without /api prefix for flexibility during deployment
        const isAuthRoute = 
            normalizedPath === '/api/auth/register' || normalizedPath === '/auth/register' ||
            normalizedPath === '/api/auth/login' || normalizedPath === '/auth/login';

        if (isAuthRoute && method === 'POST') {
            const body = await parseBody(req);
            const isLogin = normalizedPath.includes('login');
            const result = isLogin ? await loginUser(body) : await registerUser(body);
            return sendJSON(res, isLogin ? 200 : 201, result);
        }

        // ---------- Protected Routes ----------
        const userId = await authenticate(req, res);
        if (!userId) return; // Auth failed, response already sent

        if (pathname === '/api/auth/me' && method === 'GET') {
            const user = await getMe(userId);
            return sendJSON(res, 200, user);
        }

        if (pathname === '/api/users/avatar' && method === 'POST') {
            const uploadDir = path.join(__dirname, '..', 'client', 'src', 'assets', 'image', 'usericon');

            // Ensure directory exists
            if (!fs.existsSync(uploadDir)) {
                fs.mkdirSync(uploadDir, { recursive: true });
            }

            const form = formidable({
                uploadDir,
                keepExtensions: false, // Don't include extensions to keep filename constant
                maxFiles: 1,
                filename: (name, ext, part, form) => {
                    return userId; // Filename is exactly the userId
                }
            });

            return new Promise((resolve) => {
                form.parse(req, async (err, fields, files) => {
                    if (err) {
                        sendJSON(res, 400, { message: 'Upload failed' });
                        return resolve();
                    }
                    const file = files.avatar?.[0] || files.avatar;
                    if (!file) {
                        sendJSON(res, 400, { message: 'No file uploaded' });
                        return resolve();
                    }

                    const fileName = path.basename(file.filepath);
                    const avatarPath = fileName;

                    try {
                        const updatedUser = await updateAvatar(userId, avatarPath);
                        sendJSON(res, 200, updatedUser);
                    } catch (dbErr) {
                        sendJSON(res, 500, { message: dbErr.message });
                    }
                    resolve();
                });
            });
        }

        // ---------- Transactions ----------
        if (pathname === '/api/transactions' && method === 'GET') {
            const data = await getTransactions(userId);
            return sendJSON(res, 200, data);
        }

        if (pathname === '/api/transactions' && method === 'POST') {
            const body = await parseBody(req);
            const newTx = await addTransaction(userId, body);
            return sendJSON(res, 201, newTx);
        }

        if (pathname.startsWith('/api/transactions/') && method === 'DELETE') {
            const id = pathname.split('/').pop();
            const result = await deleteTransaction(userId, id);
            if (!result) return sendJSON(res, 404, { message: 'Transaction not found or unauthorized' });
            return sendJSON(res, 200, result);
        }

        if (pathname.startsWith('/api/transactions/') && method === 'PUT') {
            const id = pathname.split('/').pop();
            const body = await parseBody(req);
            const updated = await updateTransaction(userId, id, body);
            if (!updated) return sendJSON(res, 404, { message: 'Transaction not found or unauthorized' });
            return sendJSON(res, 200, updated);
        }

        // ---------- Dashboard ----------
        if (pathname === '/api/dashboard/stats' && method === 'GET') {
            const data = await getDashboardStats(userId);
            return sendJSON(res, 200, data);
        }

        // ---------- Bank Accounts ----------
        if (pathname === '/api/bank-accounts' && method === 'GET') {
            return sendJSON(res, 200, getBankAccounts());
        }

        // ---------- Statistics ----------
        if (pathname === '/api/statistics' && method === 'GET') {
            const params = Object.fromEntries(url.searchParams);
            const data = await getStatistics(userId, params);
            return sendJSON(res, 200, data);
        }

        // ---------- Debts ----------
        if (pathname === '/api/debts' && method === 'GET') {
            const data = await getDebts(userId);
            return sendJSON(res, 200, data);
        }

        if (pathname === '/api/debts' && method === 'POST') {
            const body = await parseBody(req);
            const data = await addDebt(userId, body);
            return sendJSON(res, 201, data);
        }

        if (pathname.startsWith('/api/debts/') && method === 'PUT') {
            const id = pathname.split('/').pop();
            const body = await parseBody(req);
            const updated = await updateDebt(userId, id, body);
            if (!updated) return sendJSON(res, 404, { message: 'Debt not found' });
            return sendJSON(res, 200, updated);
        }

        if (pathname.startsWith('/api/debts/') && method === 'DELETE') {
            const id = pathname.split('/').pop();
            const result = await deleteDebt(userId, id);
            if (!result) return sendJSON(res, 404, { message: 'Debt not found' });
            return sendJSON(res, 200, result);
        }

        // ---------- Savings ----------
        if (pathname === '/api/savings' && method === 'GET') {
            const data = await getSavings(userId);
            return sendJSON(res, 200, data);
        }


        // ---------- 404 ----------
        sendJSON(res, 404, { message: 'Route not found' });

    } catch (err) {
        console.error('Server error:', err);
        sendJSON(res, 400, { message: err.message || 'Internal server error' });
    }
}

// --- Start Server ---
async function startServer() {
    await connectDB();

    const server = http.createServer((req, res) => {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const pathname = url.pathname;

        // Serve static avatar files
        if (pathname.startsWith('/uploads/avatars/') && req.method === 'GET') {
            const fileName = pathname.split('/').pop();
            const filePath = path.join(__dirname, '..', 'client', 'src', 'assets', 'image', 'usericon', fileName);

            if (fs.existsSync(filePath)) {
                // Serve as image/jpeg, browsers will detect actual format
                res.writeHead(200, {
                    'Content-Type': 'image/jpeg',
                    'Access-Control-Allow-Origin': '*',
                    'Cache-Control': 'no-cache, no-store, must-revalidate'
                });
                return fs.createReadStream(filePath).pipe(res);
            } else {
                res.writeHead(404);
                return res.end();
            }
        }

        handleRequest(req, res);
    });

    server.listen(PORT, () => {
        console.log(`\n  🚀 Server running at http://localhost:${PORT}`);
        console.log(`  📡 API base: http://localhost:${PORT}/api\n`);
    });
}

startServer();
