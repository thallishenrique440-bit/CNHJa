import fs from 'fs';

try {
  const envText = fs.readFileSync('.env', 'utf8');
  for (const line of envText.split('\n')) {
    if (line.trim() && !line.startsWith('#')) {
      const parts = line.split('=');
      console.log(parts[0], '=', parts[1] ? parts[1].substring(0, 8) + '...' : '');
    }
  }
} catch (e: any) {
  console.log('Error reading .env:', e.message);
}
