async function check() {
  try {
    const response = await fetch('http://localhost:3000/api/debug-env');
    const data = await response.json();
    console.log('Backend Env:', JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('Error fetching debug-env:', error);
  }
}
check();
