// ============================================================
//  Cloudflare Workers 版自动发卡平台后端
//  存储：Cloudflare D1 (SQLite)
//  会话：D1 sessions 表
// ============================================================

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });

const err = (msg, status = 400) => json({ error: msg }, status);

const uid = (p = '') =>
  p + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

function genOrderNo() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
       + `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
       + Math.floor(Math.random() * 9000 + 1000);
}

async function getSetting(env, key) {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
  return row ? row.value : null;
}

async function setSetting(env, key, value) {
  await env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    .bind(key, String(value)).run();
}

async function auth(request, env) {
  const h = request.headers.get('Authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) return null;
  const row = await env.DB.prepare('SELECT * FROM sessions WHERE token = ?').bind(token).first();
  if (!row || row.expire < Date.now()) return null;
  return { username: row.username };
}

function orderToClient(r) {
  return {
    id: r.id,
    orderNo: r.order_no,
    productId: r.product_id,
    productName: r.product_name,
    quantity: r.quantity,
    amount: r.amount,
    contact: r.contact,
    status: r.status,
    cards: JSON.parse(r.cards_json || '[]'),
    createdAt: r.created_at,
    paidAt: r.paid_at,
  };
}

// 把数组分批执行，避免 D1 batch 超限（每批最多 100 条）
async function batchInsert(env, stmts) {
  for (let i = 0; i < stmts.length; i += 100) {
    await env.DB.batch(stmts.slice(i, i + 100));
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === 'OPTIONS') return new Response(null, { headers: CORS });

    try {
      /* ====================================================
       *  公开 API
       * ==================================================== */

      if (path === '/api/site' && method === 'GET') {
        return json({
          siteName: await getSetting(env, 'siteName'),
          siteNotice: await getSetting(env, 'siteNotice'),
          contact: await getSetting(env, 'contact'),
        });
      }

      if (path === '/api/products' && method === 'GET') {
        const { results } = await env.DB.prepare(
          `SELECT p.id, p.name, p.description, p.price, p.cover,
            (SELECT COUNT(*) FROM cards c WHERE c.product_id = p.id AND c.used = 0) AS stock
           FROM products p ORDER BY p.created_at DESC`
        ).all();
        return json(results);
      }

      if (path === '/api/orders' && method === 'POST') {
        const body = await request.json();
        const { productId, quantity, contact } = body;
        const qty = Math.floor(Number(quantity));
        if (!productId) return err('缺少商品 ID');
        if (!Number.isFinite(qty) || qty < 1) return err('购买数量不合法');
        if (qty > 100) return err('单次最多购买 100 件');

        const product = await env.DB.prepare('SELECT * FROM products WHERE id = ?')
          .bind(productId).first();
        if (!product) return err('商品不存在', 404);

        const stockRow = await env.DB.prepare(
          'SELECT COUNT(*) AS n FROM cards WHERE product_id = ? AND used = 0'
        ).bind(productId).first();
        if (stockRow.n < qty) return err('库存不足，请减少购买数量');

        const order = {
          id: uid('o_'),
          order_no: genOrderNo(),
          product_id: productId,
          product_name: product.name,
          quantity: qty,
          amount: product.price * qty,
          contact: String(contact || '').slice(0, 100),
          status: 'pending',
          cards_json: '[]',
          created_at: Date.now(),
          paid_at: null,
        };

        await env.DB.prepare(
          `INSERT INTO orders
           (id, order_no, product_id, product_name, quantity, amount, contact, status, cards_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          order.id, order.order_no, order.product_id, order.product_name,
          order.quantity, order.amount, order.contact, order.status,
          order.cards_json, order.created_at
        ).run();

        return json(orderToClient(order));
      }

      const orderMatch = path.match(/^\/api\/orders\/([A-Za-z0-9]+)$/);
      if (orderMatch && method === 'GET') {
        const row = await env.DB.prepare('SELECT * FROM orders WHERE order_no = ?')
          .bind(orderMatch[1]).first();
        if (!row) return err('订单不存在', 404);
        return json(orderToClient(row));
      }

      const payMatch = path.match(/^\/api\/orders\/([A-Za-z0-9]+)\/pay$/);
      if (payMatch && method === 'POST') {
        const order = await env.DB.prepare('SELECT * FROM orders WHERE order_no = ?')
          .bind(payMatch[1]).first();
        if (!order) return err('订单不存在', 404);
        if (order.status === 'paid') return err('该订单已支付');
        if (order.status !== 'pending') return err('订单状态异常，无法支付');

        const { results: avail } = await env.DB.prepare(
          'SELECT id, code FROM cards WHERE product_id = ? AND used = 0 LIMIT ?'
        ).bind(order.product_id, order.quantity).all();

        if (avail.length < order.quantity) return err('库存不足，请联系客服');

        const now = Date.now();
        const stmts = avail.map(c =>
          env.DB.prepare('UPDATE cards SET used = 1, order_no = ?, used_at = ? WHERE id = ?')
            .bind(order.order_no, now, c.id)
        );
        await env.DB.batch(stmts);

        const cardsJson = JSON.stringify(avail.map(c => ({ code: c.code })));
        await env.DB.prepare(
          "UPDATE orders SET status = 'paid', cards_json = ?, paid_at = ? WHERE order_no = ?"
        ).bind(cardsJson, now, order.order_no).run();

        const updated = await env.DB.prepare('SELECT * FROM orders WHERE order_no = ?')
          .bind(order.order_no).first();
        return json(orderToClient(updated));
      }

      /* ====================================================
       *  管理端登录
       * ==================================================== */

      if (path === '/api/admin/login' && method === 'POST') {
        const { username, password } = await request.json();
        const u = await getSetting(env, 'adminUsername');
        const p = await getSetting(env, 'adminPassword');
        if (username !== u || password !== p) return err('用户名或密码错误', 401);

        const token = crypto.randomUUID().replace(/-/g, '');
        const expire = Date.now() + 12 * 60 * 60 * 1000;
        await env.DB.prepare('INSERT INTO sessions (token, username, expire) VALUES (?, ?, ?)')
          .bind(token, username, expire).run();
        return json({ token, username });
      }

      // 以下接口均需登录
      const user = await auth(request, env);
      if (!user) return err('未登录或登录已过期', 401);

      /* ====================================================
       *  管理端：仪表盘
       * ==================================================== */

      if (path === '/api/admin/stats' && method === 'GET') {
        const [pc, oc, poc, rev, cc, cuc] = await Promise.all([
          env.DB.prepare('SELECT COUNT(*) AS n FROM products').first(),
          env.DB.prepare('SELECT COUNT(*) AS n FROM orders').first(),
          env.DB.prepare("SELECT COUNT(*) AS n FROM orders WHERE status = 'paid'").first(),
          env.DB.prepare("SELECT COALESCE(SUM(amount), 0) AS n FROM orders WHERE status = 'paid'").first(),
          env.DB.prepare('SELECT COUNT(*) AS n FROM cards').first(),
          env.DB.prepare('SELECT COUNT(*) AS n FROM cards WHERE used = 1').first(),
        ]);
        return json({
          productCount: pc.n,
          orderCount: oc.n,
          paidOrderCount: poc.n,
          revenue: rev.n,
          cardTotal: cc.n,
          cardUsed: cuc.n,
        });
      }

      /* ====================================================
       *  管理端：商品
       * ==================================================== */

      if (path === '/api/admin/products' && method === 'GET') {
        const { results } = await env.DB.prepare(
          `SELECT p.*, (SELECT COUNT(*) FROM cards c WHERE c.product_id = p.id AND c.used = 0) AS stock
           FROM products p ORDER BY p.created_at DESC`
        ).all();
        return json(results.map(r => ({
          id: r.id, name: r.name, description: r.description, price: r.price,
          cover: r.cover, stock: r.stock, createdAt: r.created_at,
        })));
      }

      if (path === '/api/admin/products' && method === 'POST') {
        const { name, description, price, cover } = await request.json();
        if (!name || !String(name).trim()) return err('商品名称不能为空');
        const p = Math.round(Number(price));
        if (!Number.isFinite(p) || p < 1) return err('价格必须大于 0');

        const product = {
          id: uid('p_'),
          name: String(name).trim().slice(0, 80),
          description: String(description || '').slice(0, 500),
          price: p,
          cover: String(cover || '').slice(0, 500),
          created_at: Date.now(),
        };
        await env.DB.prepare(
          'INSERT INTO products (id, name, description, price, cover, created_at) VALUES (?, ?, ?, ?, ?, ?)'
        ).bind(
          product.id, product.name, product.description, product.price,
          product.cover, product.created_at
        ).run();
        return json({
          id: product.id, name: product.name, description: product.description,
          price: product.price, cover: product.cover,
        });
      }

      const prodMatch = path.match(/^\/api\/admin\/products\/([^/]+)$/);
      if (prodMatch && method === 'PUT') {
        const id = prodMatch[1];
        const body = await request.json();
        const existing = await env.DB.prepare('SELECT * FROM products WHERE id = ?').bind(id).first();
        if (!existing) return err('商品不存在', 404);

        const name = body.name !== undefined ? String(body.name).trim().slice(0, 80) : existing.name;
        if (!name) return err('商品名称不能为空');
        const price = body.price !== undefined ? Math.round(Number(body.price)) : existing.price;
        if (!Number.isFinite(price) || price < 1) return err('价格必须大于 0');
        const description = body.description !== undefined
          ? String(body.description).slice(0, 500) : existing.description;
        const cover = body.cover !== undefined
          ? String(body.cover).slice(0, 500) : existing.cover;

        await env.DB.prepare(
          'UPDATE products SET name = ?, description = ?, price = ?, cover = ? WHERE id = ?'
        ).bind(name, description, price, cover, id).run();
        return json({ id, name, description, price, cover });
      }

      if (prodMatch && method === 'DELETE') {
        const id = prodMatch[1];
        await env.DB.prepare('DELETE FROM products WHERE id = ?').bind(id).run();
        await env.DB.prepare('DELETE FROM cards WHERE product_id = ? AND used = 0').bind(id).run();
        return json({ ok: true });
      }

      /* ====================================================
       *  管理端：卡密
       * ==================================================== */

      const cardsMatch = path.match(/^\/api\/admin\/products\/([^/]+)\/cards$/);
      if (cardsMatch && method === 'GET') {
        const { results } = await env.DB.prepare(
          'SELECT * FROM cards WHERE product_id = ? ORDER BY used ASC, created_at DESC'
        ).bind(cardsMatch[1]).all();
        return json(results.map(c => ({
          id: c.id, productId: c.product_id, code: c.code, used: !!c.used,
          orderNo: c.order_no, usedAt: c.used_at, createdAt: c.created_at,
        })));
      }

      if (cardsMatch && method === 'POST') {
        const id = cardsMatch[1];
        const product = await env.DB.prepare('SELECT id FROM products WHERE id = ?').bind(id).first();
        if (!product) return err('商品不存在', 404);

        const { codes: rawCodes } = await request.json();
        const codes = [...new Set(String(rawCodes || '')
          .split(/\r?\n/).map(s => s.trim()).filter(Boolean))];
        if (!codes.length) return err('请输入卡密内容');
        if (codes.length > 5000) return err('单次最多添加 5000 条');

        const { results: existing } = await env.DB.prepare(
          'SELECT code FROM cards WHERE product_id = ?'
        ).bind(id).all();
        const existingSet = new Set(existing.map(e => e.code));

        const now = Date.now();
        const stmts = [];
        let added = 0;
        for (const code of codes) {
          if (existingSet.has(code)) continue;
          existingSet.add(code);
          stmts.push(
            env.DB.prepare(
              'INSERT INTO cards (id, product_id, code, used, created_at) VALUES (?, ?, ?, 0, ?)'
            ).bind(uid('c_'), id, code, now)
          );
          added++;
        }
        await batchInsert(env, stmts);
        return json({ added, skipped: codes.length - added });
      }

      const cardDelMatch = path.match(/^\/api\/admin\/cards\/([^/]+)$/);
      if (cardDelMatch && method === 'DELETE') {
        const card = await env.DB.prepare('SELECT * FROM cards WHERE id = ?')
          .bind(cardDelMatch[1]).first();
        if (!card) return err('卡密不存在', 404);
        if (card.used) return err('已使用的卡密不能删除');
        await env.DB.prepare('DELETE FROM cards WHERE id = ?').bind(cardDelMatch[1]).run();
        return json({ ok: true });
      }

      /* ====================================================
       *  管理端：订单
       * ==================================================== */

      if (path === '/api/admin/orders' && method === 'GET') {
        const status = url.searchParams.get('status');
        const keyword = url.searchParams.get('keyword');
        let sql = 'SELECT * FROM orders WHERE 1=1';
        const params = [];
        if (status) { sql += ' AND status = ?'; params.push(status); }
        if (keyword) {
          sql += ' AND (order_no LIKE ? OR product_name LIKE ? OR contact LIKE ?)';
          const k = `%${keyword}%`;
          params.push(k, k, k);
        }
        sql += ' ORDER BY created_at DESC LIMIT 500';
        const stmt = env.DB.prepare(sql);
        const { results } = params.length ? await stmt.bind(...params).all() : await stmt.all();
        return json(results.map(orderToClient));
      }

      const closeMatch = path.match(/^\/api\/admin\/orders\/([^/]+)\/close$/);
      if (closeMatch && method === 'POST') {
        const o = await env.DB.prepare('SELECT * FROM orders WHERE order_no = ?')
          .bind(closeMatch[1]).first();
        if (!o) return err('订单不存在', 404);
        if (o.status !== 'pending') return err('只有待支付订单可以关闭');
        await env.DB.prepare("UPDATE orders SET status = 'closed' WHERE order_no = ?")
          .bind(closeMatch[1]).run();
        return json({ ok: true });
      }

      const orderDelMatch = path.match(/^\/api\/admin\/orders\/([^/]+)$/);
      if (orderDelMatch && method === 'DELETE') {
        await env.DB.prepare('DELETE FROM orders WHERE order_no = ?')
          .bind(orderDelMatch[1]).run();
        return json({ ok: true });
      }

      /* ====================================================
       *  管理端：系统设置
       * ==================================================== */

      if (path === '/api/admin/settings' && method === 'GET') {
        const { results } = await env.DB.prepare('SELECT key, value FROM settings').all();
        const map = {};
        results.forEach(r => { map[r.key] = r.value; });
        return json({
          siteName: map.siteName,
          siteNotice: map.siteNotice,
          contact: map.contact,
          adminUsername: map.adminUsername,
        });
      }

      if (path === '/api/admin/settings' && method === 'PUT') {
        const body = await request.json();
        if (body.siteName !== undefined)
          await setSetting(env, 'siteName', String(body.siteName).slice(0, 40) || '自动发卡');
        if (body.siteNotice !== undefined)
          await setSetting(env, 'siteNotice', String(body.siteNotice).slice(0, 300));
        if (body.contact !== undefined)
          await setSetting(env, 'contact', String(body.contact).slice(0, 100));
        if (body.adminUsername !== undefined && String(body.adminUsername).trim()) {
          await setSetting(env, 'adminUsername', String(body.adminUsername).trim().slice(0, 40));
        }
        let relogin = false;
        if (body.adminPassword) {
          await setSetting(env, 'adminPassword', String(body.adminPassword).slice(0, 60));
          await env.DB.prepare('DELETE FROM sessions').run();
          relogin = true;
        }
        return json({ ok: true, relogin });
      }

      return err('接口不存在', 404);
    } catch (e) {
      console.error(e);
      return err('服务器内部错误：' + e.message, 500);
    }
  },
};
