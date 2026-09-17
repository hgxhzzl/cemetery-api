require('dotenv').config();

const baseUrl = process.env.SMOKE_BASE_URL || `http://127.0.0.1:${process.env.PORT || 3000}`;
const username = process.env.SMOKE_USERNAME || '13766891959';
const password = process.env.SMOKE_PASSWORD || '1234';
const runMutationCheck = process.env.SMOKE_RUN_MUTATION === '1';

async function expectJson(response, label) {
  const text = await response.text();

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} did not return JSON. status=${response.status}, body=${text.slice(0, 200)}`);
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function login() {
  const response = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const body = await expectJson(response, 'login');

  assert(response.status === 200, `login expected 200, got ${response.status}`);
  assert(body && body.data && body.data.token, 'login response missing token');

  return body.data.token;
}

async function checkJsonRoute(name, path, token, expectedStatus, verifyBody) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { Authorization: token },
  });
  const body = await expectJson(response, name);

  assert(response.status === expectedStatus, `${name} expected ${expectedStatus}, got ${response.status}`);
  verifyBody(body);

  return {
    name,
    status: response.status,
  };
}

async function checkSameValueAccountUpdate(token) {
  const queryResponse = await fetch(`${baseUrl}/api/account-query?idAccount=100`, {
    headers: { Authorization: token },
  });
  const queryBody = await expectJson(queryResponse, 'account-query for transaction check');

  assert(queryResponse.status === 200, `account-query for transaction check expected 200, got ${queryResponse.status}`);
  assert(queryBody && queryBody.data && Array.isArray(queryBody.data.list), 'account-query for transaction check missing list');
  assert(queryBody.data.list.length === 1, `account-query for transaction check expected 1 item, got ${queryBody.data.list.length}`);

  const item = queryBody.data.list[0];
  const payload = {
    idAccount: String(item.idAccount),
    dataBaseName: item.dataBaseName,
    head: item.head,
    phone: item.phone,
    useStatus: item.useStatus,
  };

  const updateResponse = await fetch(`${baseUrl}/api/account-save/update`, {
    method: 'POST',
    headers: {
      Authorization: token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const updateBody = await expectJson(updateResponse, 'account-save update transaction check');

  assert(updateResponse.status === 200, `account-save update transaction check expected 200, got ${updateResponse.status}`);
  assert(updateBody && updateBody.code === 0, 'account-save update transaction check missing code=0');
  assert(Number(updateBody.affectedRows) >= 1, 'account-save update transaction check missing affectedRows');

  return {
    name: 'account-save same value update',
    status: updateResponse.status,
    affectedRows: Number(updateBody.affectedRows) || 0,
  };
}

async function checkInvalidRoomUpdate(token) {
  const response = await fetch(`${baseUrl}/api/room-save/update`, {
    method: 'POST',
    headers: {
      Authorization: token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      modify: '2',
      xNum: 'abc',
      xNumTo: '2',
      yNum: '1',
      yNumTo: '2',
      region: 'A区',
      park: '福位区',
      price: '1000',
    }),
  });
  const body = await expectJson(response, 'room-save invalid coords');

  assert(response.status === 400, `room-save invalid coords expected 400, got ${response.status}`);
  assert(body && body.error === '房位坐标参数错误!', 'room-save invalid coords returned unexpected error body');

  return {
    name: 'room-save invalid coords',
    status: response.status,
  };
}

async function checkOperatorPasswordWrongOld(token) {
  const response = await fetch(`${baseUrl}/api/operator-save/password`, {
    method: 'POST',
    headers: {
      Authorization: token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      idOperator: '100',
      oldPassword: '__wrong__',
      newPassword: '__not_used__',
    }),
  });
  const body = await expectJson(response, 'operator-save wrong old password');

  assert(response.status === 200, `operator-save wrong old password expected 200, got ${response.status}`);
  assert(body && body.code === 0, 'operator-save wrong old password missing code=0');
  assert(body.data === 0, 'operator-save wrong old password expected data=0');

  return {
    name: 'operator-save wrong old password',
    status: response.status,
  };
}

async function main() {
  const token = await login();
  const results = [];

  results.push(await checkJsonRoute('menu', '/api/get-menu-list-i18n', token, 200, (body) => {
    assert(body && body.code === 0, 'menu response missing code=0');
    assert(body.data && Array.isArray(body.data.list), 'menu response missing list');
  }));

  results.push(await checkJsonRoute('account-query', '/api/account-query?idAccount=100', token, 200, (body) => {
    assert(body && body.code === 0, 'account-query response missing code=0');
    assert(body.data && Array.isArray(body.data.list), 'account-query response missing list');
    assert(body.data.list.length === 1, `account-query expected 1 item, got ${body.data.list.length}`);
  }));

  results.push(await checkJsonRoute('contract-query', '/api/contract-query', token, 200, (body) => {
    assert(body && body.code === 0, 'contract-query response missing code=0');
    assert(body.data && Array.isArray(body.data.list), 'contract-query response missing list');
  }));

  results.push(await checkJsonRoute('operator-query missing detail', '/api/operator-query/id?idOperator=999999999', token, 404, (body) => {
    assert(body && body.error === '数据不存在!', 'operator-query missing detail returned unexpected error body');
  }));

  results.push(await checkJsonRoute('room-query missing detail', '/api/room-query/idList?idRoom=999999999', token, 404, (body) => {
    assert(body && body.error === '数据不存在!', 'room-query missing detail returned unexpected error body');
  }));

  results.push(await checkJsonRoute('room-query invalid detail id', '/api/room-query/idList?idRoom=abc', token, 400, (body) => {
    assert(body && body.error === 'idRoom参数错误!', 'room-query invalid detail id returned unexpected error body');
  }));

  results.push(await checkJsonRoute('park-query region', '/api/park-query/region', token, 200, (body) => {
    assert(body && body.code === 0, 'park-query/region response missing code=0');
    assert(body.data && Array.isArray(body.data.list), 'park-query/region response missing list');
  }));

  results.push(await checkJsonRoute('taginfo-query tagset', '/api/taginfo-query/tagset', token, 200, (body) => {
    assert(body && body.code === 0, 'taginfo-query/tagset response missing code=0');
    assert(body.data && Array.isArray(body.data.list), 'taginfo-query/tagset response missing list');
  }));

  results.push(await checkInvalidRoomUpdate(token));
  results.push(await checkOperatorPasswordWrongOld(token));

  if (runMutationCheck) {
    results.push(await checkSameValueAccountUpdate(token));
  }

  console.log(JSON.stringify({ baseUrl, runMutationCheck, results }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
