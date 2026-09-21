// Spec sections 3-6: app shell, practice, design studio, community.
const { test, expect } = require('./support/fixtures');

test.describe('Navigation (spec section 3)', () => {
  test('NAV-01 sidebar has Home, Play, Raid, Shop, Design, Community, Create in order', async ({ page }) => {
    const labels = await page.$$eval('#sidebar .nav-button', (els) => els.map((e) => e.textContent.replace(/[^\w ]/gu, '').trim()));
    expect(labels).toEqual(['Home', 'Play', 'Raid', 'Shop', 'Design', 'Community', 'Create']);
    expect(labels).not.toContain('Lobby');
  });

  test('NAV-02 sidebar shows the coin balance', async ({ page }) => {
    await page.evaluate(() => { mqProfile.coins = 1234; mqRefreshCoinUI(); });
    await expect(page.locator('.sidebar-coins .mq-coin-value')).toHaveText('1,234');
  });

  test('NAV-03 one section is visible at a time and the nav button highlights', async ({ page }) => {
    await page.locator('#sidebar .nav-button', { hasText: 'Shop' }).click();
    const active = await page.$$eval('.section.active', (els) => els.map((e) => e.id));
    expect(active).toEqual(['shop']);
    await expect(page.locator('#sidebar .nav-button.active-nav')).toHaveText(/Shop/);
    await page.locator('#sidebar .nav-button', { hasText: 'Home' }).click();
    expect(await page.$$eval('.section.active', (els) => els.map((e) => e.id))).toEqual(['home']);
  });

  test('NAV-04 home shows stats and a Play button', async ({ page }) => {
    await expect(page.locator('#homeScore')).toBeVisible();
    await expect(page.locator('#homeStreak')).toBeVisible();
    await expect(page.getByRole('button', { name: /PLAY NOW/ })).toBeVisible();
  });
});

test.describe('Practice (spec section 4)', () => {
  test('PRA-01 a round is 20 questions with 4 unique options including the answer', async ({ page }) => {
    const r = await page.evaluate(() => {
      startPractice('addition');
      const opts = Array.from(document.querySelectorAll('#options .option-btn')).map((b) => Number(b.innerText));
      return { total: TOTAL_QUESTIONS, opts, answer: currentAnswer };
    });
    expect(r.total).toBe(20);
    expect(r.opts).toHaveLength(4);
    expect(new Set(r.opts).size).toBe(4);
    expect(r.opts).toContain(r.answer);
  });

  test('PRA-02 addition and subtraction sets exist with correct answers; Play starts addition', async ({ page }) => {
    const r = await page.evaluate(() => {
      const check = (set, op) => questionSets[set].every((q) => {
        const [a, b] = q.question.split(op).map(Number);
        return op.trim() === '+' ? a + b === q.answer : a - b === q.answer;
      });
      goToPractice();
      return {
        add: questionSets.addition.length, sub: questionSets.subtraction.length,
        addOk: check('addition', ' + '), subOk: check('subtraction', ' - '), current: currentSet
      };
    });
    expect(r.add).toBeGreaterThan(0);
    expect(r.sub).toBeGreaterThan(0);
    expect(r.addOk).toBe(true);
    expect(r.subOk).toBe(true);
    expect(r.current).toBe('addition');
  });

  test('PRA-03 score, streak and best streak track answers', async ({ page }) => {
    const r = await page.evaluate(() => {
      const answer = (correct) => {
        generateQuestion();
        const btns = Array.from(document.querySelectorAll('#options .option-btn'));
        const pick = btns.find((b) => (Number(b.innerText) === currentAnswer) === correct);
        pick.click();
      };
      startPractice('addition');
      const out = [];
      answer(true); answer(true); out.push([score, streak, bestStreak]);
      answer(false); out.push([score, streak, bestStreak]);
      answer(true); out.push([score, streak, bestStreak]);
      return out;
    });
    expect(r).toEqual([[2, 2, 2], [2, 0, 2], [3, 1, 2]]);
  });

  test('PRA-04 community sets play in the practice UI', async ({ page }) => {
    const r = await page.evaluate(async () => {
      __fb.firestore.collections.publicSets = { abc: { name: 'Mine', questions: [{ question: '2 + 2', answer: 4 }] } };
      await playPublicSet('abc');
      return { set: currentSet, q: document.getElementById('question').innerText, answer: currentAnswer, active: document.querySelector('.section.active').id };
    });
    expect(r).toEqual({ set: 'community', q: '2 + 2', answer: 4, active: 'practice' });
  });
});

test.describe('Design Studio (spec section 5)', () => {
  test('DES-01 colors, roundness and shadow update the page live', async ({ page }) => {
    const r = await page.evaluate(() => {
      document.getElementById('bg1').value = '#112233';
      document.getElementById('sidebarColor').value = '#445566';
      document.getElementById('primaryColor').value = '#778899';
      document.getElementById('roundness').value = '33';
      document.getElementById('shadow').value = '24';
      updateDesign();
      const s = getComputedStyle(document.documentElement);
      return { bg1: s.getPropertyValue('--bg1').trim(), sidebar: s.getPropertyValue('--sidebar').trim(), primary: s.getPropertyValue('--primary').trim(), radius: s.getPropertyValue('--radius').trim(), shadow: s.getPropertyValue('--shadow').trim() };
    });
    expect(r).toEqual({ bg1: '#112233', sidebar: '#445566', primary: '#778899', radius: '33px', shadow: '0 12px 24px rgba(0,0,0,0.15)' });
  });

  test('DES-02 has purple, ocean, forest, sunset and candy presets', async ({ page }) => {
    const r = await page.evaluate(() => {
      const out = {};
      ['purple', 'ocean', 'forest', 'sunset', 'candy'].forEach((n) => { theme(n); out[n] = getComputedStyle(document.documentElement).getPropertyValue('--bg1').trim(); });
      return out;
    });
    expect(Object.keys(r)).toHaveLength(5);
    expect(new Set(Object.values(r)).size).toBe(5);
    expect(r.purple).toBe('#667eea');
  });
});

test.describe('Community and Create (spec section 6)', () => {
  test('COM-01 lists public sets and filters by search', async ({ page }) => {
    await page.evaluate(() => {
      __fb.firestore.collections.publicSets = {
        a: { name: 'Fractions Fun', creatorName: 'Ana', description: 'halves', questions: [{ question: '1', answer: 1 }] },
        b: { name: 'Times Tables', creatorName: 'Bo', description: 'multiply', questions: [{ question: '2', answer: 2 }] }
      };
    });
    await page.evaluate(() => loadCommunitySets());
    await expect(page.locator('.community-set-card')).toHaveCount(2);
    await page.evaluate(() => showSection('community'));
    await page.fill('#communitySearch', 'times');
    await expect(page.locator('.community-set-card')).toHaveCount(1);
    await expect(page.locator('.community-set-card h3')).toHaveText('Times Tables');
  });

  test('COM-02 create form validates name, question count/limit and numeric answers', async ({ page }) => {
    const status = () => page.locator('#creatorStatus').innerText();
    await page.evaluate(() => showSection('create'));
    await page.evaluate(() => publishCreatorSet());
    expect(await status()).toMatch(/set name/i);

    await page.fill('#creatorSetName', 'My set');
    await page.evaluate(() => { document.getElementById('creatorQuestions').innerHTML = ''; return publishCreatorSet(); });
    expect(await status()).toMatch(/at least one question/i);

    await page.evaluate(() => { for (let i = 0; i < 101; i++) addCreatorQuestion(); return publishCreatorSet(); });
    expect(await status()).toMatch(/at most 100/i);

    await page.evaluate(() => { document.getElementById('creatorQuestions').innerHTML = ''; addCreatorQuestion(); });
    await page.fill('.cq-question', '2 + 2');
    await page.fill('.cq-answer', 'four');
    await page.evaluate(() => publishCreatorSet());
    expect(await status()).toMatch(/numbers/i);
  });

  test('COM-03 publishing writes to publicSets with the owner uid; rules are owner-only', async ({ page }) => {
    await page.evaluate(() => showSection('create'));
    await page.fill('#creatorSetName', 'Set A');
    await page.fill('#creatorName', 'Zed');
    await page.fill('.cq-question', '3 + 4');
    await page.fill('.cq-answer', '7');
    await page.evaluate(() => publishCreatorSet());
    await expect(page.locator('#creatorStatus')).toContainText('Published');
    const add = await page.evaluate(() => __fb.firestore.adds[0]);
    expect(add.collection).toBe('publicSets');
    expect(add.data.ownerId).toBe('test-uid');
    expect(add.data.name).toBe('Set A');
    expect(add.data.questions).toEqual([{ question: '3 + 4', answer: 7 }]);

    const rules = require('fs').readFileSync(require('path').join(__dirname, '..', 'firestore.rules'), 'utf8');
    expect(rules).toMatch(/allow read: if true/);
    expect(rules).toMatch(/ownerId == request\.auth\.uid/);
    expect(rules).toMatch(/questions\.size\(\) <= 100/);
    expect(rules).toMatch(/allow read, write: if false/);
  });
});
