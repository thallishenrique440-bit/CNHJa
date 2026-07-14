import dns from 'dns';

dns.resolve4('db.ohftsqsxymtrclnpadam.supabase.co', (err, addresses) => {
  if (err) {
    console.error('IPv4 Resolve Error:', err);
  } else {
    console.log('IPv4 Addresses:', addresses);
  }
});

dns.resolve6('db.ohftsqsxymtrclnpadam.supabase.co', (err, addresses) => {
  if (err) {
    console.error('IPv6 Resolve Error:', err);
  } else {
    console.log('IPv6 Addresses:', addresses);
  }
});
