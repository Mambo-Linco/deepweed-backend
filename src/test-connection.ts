import { pool } from './db/pool';

async function testConnection() {
    console.log('🧪 Testing database connection...');
    
    try {
        const client = await pool.connect();
        console.log('✅ Connected successfully!');
        
        const result = await client.query('SELECT NOW() as current_time, version() as version');
        console.log('📅 Server time:', result.rows[0].current_time);
        console.log('🐘 PostgreSQL version:', result.rows[0].version);
        
        client.release();
        console.log('✅ Test completed successfully!');
    } catch (error) {
        console.error('❌ Connection test failed:', error);
    } finally {
        await pool.end();
    }
}

testConnection();