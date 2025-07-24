// =============================================================================
// SIMPLE GASLESS RELAYER SERVICE - pays gas fees for users
// =============================================================================

const express = require('express');
const cors = require('cors');
const { ethers } = require('ethers');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// =============================================================================
// CONFIGURATION
// =============================================================================
const CONFIG = {
    // Sepolia Testnet
    RPC_URL: process.env.SEPOLIA_RPC_URL || 'https://sepolia.infura.io/v3/4e0cae7921c4439b80fb6b7415d13df8',
    RELAYER_PRIVATE_KEY: process.env.RELAYER_PRIVATE_KEY,
    
    // Contract addresses (UPDATE THESE WITH YOUR DEPLOYED ADDRESSES)
    PAYMENT_PROCESSOR_ADDRESS: process.env.PAYMENT_PROCESSOR_ADDRESS,
    NZDD_TOKEN_ADDRESS: process.env.NZDD_TOKEN_ADDRESS,
    
    // Gas settings
    GAS_LIMIT: 500000,
    MIN_BALANCE: ethers.utils.parseEther('0.02'), // Alert when below 0.02 ETH
    
    // Webhook
    GOOGLE_SCRIPT_URL: 'https://script.google.com/macros/s/AKfycbyWIUmSlIFUcbw-vdtnSuP1-gPJru-n_Jmp3oLvaLaQYNbmtxERsV2dfj4GkZj2p-GGzw/exec'
};

// =============================================================================
// ETHEREUM SETUP
// =============================================================================
const provider = new ethers.providers.JsonRpcProvider(CONFIG.RPC_URL);
const relayerWallet = new ethers.Wallet(CONFIG.RELAYER_PRIVATE_KEY, provider);

// Simple contract ABI for the functions we need
const PAYMENT_PROCESSOR_ABI = [
    "function createWalletAndCredit(address userWallet, string email, string irdNumber) external returns (bytes32)",
    "function transferTokens(address from, address to, uint256 amount, string description) external returns (bytes32)",
    "function getUserInfo(address wallet) external view returns (string, string, uint256, bool)",
    "function owner() external view returns (address)"
];

const NZDD_TOKEN_ABI = [
    "function balanceOf(address account) external view returns (uint256)",
    "function transfer(address to, uint256 amount) external returns (bool)",
    "function approve(address spender, uint256 amount) external returns (bool)"
];

// Contract instances
let paymentProcessorContract, nzddTokenContract;

// =============================================================================
// RATE LIMITING
// =============================================================================
const createAccountLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5, // limit each IP to 5 account creations per windowMs
    message: 'Too many account creation attempts, please try again later.'
});

const transactionLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 10, // limit each IP to 10 transactions per minute
    message: 'Too many transaction attempts, please try again later.'
});

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

// Initialize contracts
async function initializeContracts() {
    if (!CONFIG.PAYMENT_PROCESSOR_ADDRESS) {
        console.log('⚠️  Payment Processor address not set. Please set PAYMENT_PROCESSOR_ADDRESS in environment.');
        return false;
    }
    
    try {
        paymentProcessorContract = new ethers.Contract(
            CONFIG.PAYMENT_PROCESSOR_ADDRESS,
            PAYMENT_PROCESSOR_ABI,
            relayerWallet
        );

        if (CONFIG.NZDD_TOKEN_ADDRESS) {
            nzddTokenContract = new ethers.Contract(
                CONFIG.NZDD_TOKEN_ADDRESS,
                NZDD_TOKEN_ABI,
                relayerWallet
            );
        }
        
        console.log('✅ Contracts initialized');
        console.log('📄 Payment Processor:', CONFIG.PAYMENT_PROCESSOR_ADDRESS);
        console.log('🪙 NZDD Token:', CONFIG.NZDD_TOKEN_ADDRESS);
        return true;
    } catch (error) {
        console.error('❌ Contract initialization failed:', error);
        return false;
    }
}

// Check relayer balance and alert if low
async function checkRelayerBalance() {
    try {
        const balance = await relayerWallet.getBalance();
        console.log(`💰 Relayer balance: ${ethers.utils.formatEther(balance)} ETH`);
        
        if (balance.lt(CONFIG.MIN_BALANCE)) {
            console.log('🚨 LOW GAS BALANCE ALERT! Please add ETH to relayer wallet:', relayerWallet.address);
            console.log('🔗 Get ETH from: https://sepoliafaucet.com');
        }
        
        return balance;
    } catch (error) {
        console.error('❌ Failed to check balance:', error);
        return ethers.BigNumber.from(0);
    }
}

// Send webhook to Google Sheets
async function sendWebhook(data) {
    try {
        const response = await fetch(CONFIG.GOOGLE_SCRIPT_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        
        if (!response.ok) {
            throw new Error(`Webhook failed: ${response.status}`);
        }
        
        console.log('✅ Webhook sent successfully');
        return await response.json();
    } catch (error) {
        console.error('❌ Webhook failed:', error);
        // Don't throw error - webhook failure shouldn't stop the main process
        return null;
    }
}

// =============================================================================
// API ROUTES
// =============================================================================

// Health check
app.get('/health', async (req, res) => {
    try {
        const balance = await checkRelayerBalance();
        const network = await provider.getNetwork();
        
        res.json({
            status: 'healthy',
            relayerAddress: relayerWallet.address,
            balance: ethers.utils.formatEther(balance),
            network: network.name,
            chainId: network.chainId,
            contracts: {
                paymentProcessor: CONFIG.PAYMENT_PROCESSOR_ADDRESS,
                nzddToken: CONFIG.NZDD_TOKEN_ADDRESS
            },
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Create wallet and credit NZDD (GASLESS for user)
app.post('/create-wallet', createAccountLimiter, async (req, res) => {
    try {
        const { userWallet, email, irdNumber } = req.body;
        
        // Validate input
        if (!userWallet || !email || !irdNumber) {
            return res.status(400).json({ 
                error: 'Missing required fields: userWallet, email, irdNumber' 
            });
        }
        
        if (!ethers.utils.isAddress(userWallet)) {
            return res.status(400).json({ error: 'Invalid wallet address' });
        }
        
        console.log(`🚀 Creating wallet for: ${email} (${userWallet})`);
        
        // Check relayer balance
        const balance = await checkRelayerBalance();
        if (balance.lt(CONFIG.MIN_BALANCE)) {
            return res.status(503).json({ 
                error: 'Relayer has insufficient funds. Please contact support.' 
            });
        }
        
        // Execute gasless transaction (relayer pays gas)
        console.log('⛽ Relayer paying gas fees for user...');
        const tx = await paymentProcessorContract.createWalletAndCredit(
            userWallet,
            email,
            irdNumber,
            { 
                gasLimit: CONFIG.GAS_LIMIT,
                gasPrice: await provider.getGasPrice()
            }
        );
        
        console.log(`📄 Transaction sent: ${tx.hash}`);
        
        // Wait for confirmation
        const receipt = await tx.wait();
        const txHash = receipt.transactionHash;
        
        console.log(`✅ Transaction confirmed: ${txHash}`);
        console.log(`⛽ Gas used: ${receipt.gasUsed.toString()}`);
        
        // Send webhook to Google Sheets
        const webhookData = {
            action: 'wallet_created',
            wallet: userWallet,
            email: email,
            ird: irdNumber,
            txHash: txHash,
            amount: '50',
            timestamp: new Date().toISOString(),
            gasUsed: receipt.gasUsed.toString(),
            relayerAddress: relayerWallet.address
        };
        
        await sendWebhook(webhookData);
        
        // Return success response for redirect to GlideApp
        res.json({
            success: true,
            wallet: userWallet,
            email: email,
            ird: irdNumber,
            txHash: txHash,
            amount: '50',
            gasUsed: receipt.gasUsed.toString(),
            redirectUrl: `https://abhisheks-app-5xs5.glide.page/dl/5839f4?ird=${irdNumber}&email=${encodeURIComponent(email)}&wallet=${userWallet}&txHash=${txHash}`
        });
        
    } catch (error) {
        console.error('❌ Wallet creation failed:', error);
        
        // Handle specific errors
        let errorMessage = 'Wallet creation failed';
        if (error.message.includes('Already received bonus')) {
            errorMessage = 'This wallet has already received the welcome bonus';
        } else if (error.message.includes('insufficient funds')) {
            errorMessage = 'Relayer has insufficient funds for gas';
        }
        
        res.status(500).json({ 
            error: errorMessage, 
            details: error.message 
        });
    }
});

// Get user info
app.get('/user-info/:wallet', async (req, res) => {
    try {
        const { wallet } = req.params;
        
        if (!ethers.utils.isAddress(wallet)) {
            return res.status(400).json({ error: 'Invalid wallet address' });
        }
        
        const userInfo = await paymentProcessorContract.getUserInfo(wallet);
        
        res.json({
            wallet: wallet,
            email: userInfo[0],
            irdNumber: userInfo[1],
            balance: ethers.utils.formatUnits(userInfo[2], 18), // Convert from wei
            receivedBonus: userInfo[3]
        });
        
    } catch (error) {
        console.error('❌ Failed to get user info:', error);
        res.status(500).json({ 
            error: 'Failed to get user info', 
            details: error.message 
        });
    }
});

// Get relayer status and contract info
app.get('/relayer-status', async (req, res) => {
    try {
        const balance = await relayerWallet.getBalance();
        const gasPrice = await provider.getGasPrice();
        const network = await provider.getNetwork();
        
        res.json({
            relayerAddress: relayerWallet.address,
            balance: ethers.utils.formatEther(balance),
            gasPrice: ethers.utils.formatUnits(gasPrice, 'gwei'),
            minBalance: ethers.utils.formatEther(CONFIG.MIN_BALANCE),
            isLowBalance: balance.lt(CONFIG.MIN_BALANCE),
            network: network.name,
            chainId: network.chainId,
            contractAddresses: {
                paymentProcessor: CONFIG.PAYMENT_PROCESSOR_ADDRESS,
                nzddToken: CONFIG.NZDD_TOKEN_ADDRESS
            },
            fundingUrl: 'https://sepoliafaucet.com'
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Test endpoint
app.get('/test', (req, res) => {
    res.json({
        message: 'NZDD Gasless Relayer is running!',
        timestamp: new Date().toISOString(),
        relayerAddress: relayerWallet.address
    });
});

// =============================================================================
// SERVER STARTUP
// =============================================================================

const PORT = process.env.PORT || 3001;

async function startServer() {
    try {
        console.log('🚀 Starting NZDD Gasless Relayer Service...');
        
        // Check if required environment variables are set
        if (!CONFIG.RELAYER_PRIVATE_KEY) {
            console.error('❌ RELAYER_PRIVATE_KEY not set in environment variables');
            process.exit(1);
        }
        
        // Initialize contracts
        const contractsInitialized = await initializeContracts();
        if (!contractsInitialized) {
            console.error('❌ Failed to initialize contracts');
            process.exit(1);
        }
        
        // Check initial balance
        await checkRelayerBalance();
        
        // Start monitoring balance every 5 minutes
        setInterval(checkRelayerBalance, 5 * 60 * 1000);
        
        app.listen(PORT, () => {
            console.log('🎉 ================================');
            console.log(`🚀 NZDD Gasless Relayer running on port ${PORT}`);
            console.log(`📍 Relayer address: ${relayerWallet.address}`);
            console.log(`🌐 Health check: http://localhost:${PORT}/health`);
            console.log(`🔧 Test endpoint: http://localhost:${PORT}/test`);
            console.log(`💡 Fund relayer: https://sepoliafaucet.com`);
            console.log('🎉 ================================');
        });
        
    } catch (error) {
        console.error('❌ Failed to start server:', error);
        process.exit(1);
    }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down gracefully...');
    process.exit(0);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    console.error('💥 Uncaught Exception:', error);
    process.exit(1);
});

startServer();

// =============================================================================
// EXPORT FOR TESTING
// =============================================================================
module.exports = app;