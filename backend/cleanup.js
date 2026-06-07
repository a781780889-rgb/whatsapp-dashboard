const DatabaseManager = require('./src/database/DatabaseManager');

async function main() {
    await DatabaseManager.init();
    
    // Delete all disconnected duplicate accounts
    const result = await DatabaseManager.systemDB.run(
        "DELETE FROM accounts WHERE status = 'disconnected'"
    );
    console.log('Deleted', result.changes, 'duplicate/disconnected accounts');
    
    // Show remaining
    const remaining = await DatabaseManager.systemDB.all('SELECT id, name, status FROM accounts');
    console.log('Remaining accounts:', JSON.stringify(remaining, null, 2));
    
    process.exit(0);
}

main().catch(console.error);
