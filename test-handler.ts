import handler from './api/create-booking-intent.ts';

async function test() {
  const req = {
    method: 'POST',
    headers: {
      authorization: 'Bearer dummy-token'
    }
  };
  const res = {
    status: (code: number) => {
      console.log('Status:', code);
      return res;
    },
    json: (data: any) => {
      console.log('JSON:', JSON.stringify(data, null, 2));
      return res;
    }
  };

  console.log('Calling handler...');
  try {
    await handler(req, res);
  } catch (error) {
    console.error('Handler Error:', error);
  }
}

test();
