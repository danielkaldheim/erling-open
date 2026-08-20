import { createApp } from './vue.esm-browser.prod.js';

let fetchTimer = null;

const app = createApp({
  data() {
    return {
      token: localStorage.getItem('erlingToken') || '',
      state: null,
      tab: 'hjem',
      error: '',
      // registration
      regName: '', regEmoji: '🍺', regCode: '',
      // inputs keyed by question/prediction id
      inputs: {},
      // admin
      adminCode: '',
      newTeam: '',
      newCheck: '', newCheckAdmin: false,
      scorePlayer: null, scoreCustomLabel: '', scoreCustomPoints: 5,
      resolveInputs: {},
      newQ: { quizId: null, text: '', type: 'choice', options: '', answer: '', points: 5 },
      showNewQ: false,
    };
  },

  computed: {
    me() { return this.state && this.state.me; },
    isAdmin() { return !!(this.me && this.me.isAdmin); },
    myTeam() {
      if (!this.me || !this.me.teamId || !this.state.teams) return null;
      return this.state.teams.find((t) => t.id === this.me.teamId) || null;
    },
    playersByScore() {
      return this.state ? [...this.state.players].sort((a, b) => b.total - a.total) : [];
    },
    teamsByScore() {
      return this.state ? [...this.state.teams].sort((a, b) => b.total - a.total) : [];
    },
    openPredictions() { return (this.state?.predictions || []).filter((p) => p.state === 'open'); },
    pendingMissions() {
      const out = [];
      for (const m of this.state?.missions || []) {
        for (const [teamId, done] of Object.entries(m.teams)) {
          if (done.state === 'pending') {
            const team = this.state.teams.find((t) => t.id === Number(teamId));
            out.push({ id: done.id, mission: m.text, team: team ? team.name : teamId });
          }
        }
      }
      return out;
    },
    currentSlotIndex() {
      if (!this.state) return -1;
      const now = this.state.now;
      let index = -1;
      this.state.schedule.forEach((s, i) => { if (s.time <= now) index = i; });
      return index;
    },
  },

  methods: {
    async api(path, body) {
      try {
        const res = await fetch(path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Token': this.token },
          body: JSON.stringify(body || {}),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || 'Noe gikk galt');
        }
        return await res.json();
      } catch (err) {
        this.error = err.message;
        setTimeout(() => { this.error = ''; }, 3500);
        throw err;
      }
    },

    async fetchState() {
      const res = await fetch('/api/state', { headers: { 'X-Token': this.token } });
      if (res.ok) this.state = await res.json();
    },

    scheduleFetch() {
      clearTimeout(fetchTimer);
      fetchTimer = setTimeout(() => this.fetchState(), 200);
    },

    connectWS() {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.onmessage = () => this.scheduleFetch();
      ws.onclose = () => setTimeout(() => this.connectWS(), 3000);
    },

    async register() {
      const data = await this.api('/api/register', {
        name: this.regName, emoji: this.regEmoji, partyCode: this.regCode,
      });
      this.token = data.token;
      localStorage.setItem('erlingToken', this.token);
      await this.fetchState();
    },

    async unlockAdmin() {
      await this.api('/api/admin/unlock', { code: this.adminCode });
      this.adminCode = '';
      this.fetchState();
    },

    async answer(question) {
      const value = this.inputs[question.id];
      if (!value) return;
      await this.api('/api/quiz/answer', { questionId: question.id, value: String(value) });
      this.fetchState();
    },

    async answerChoice(question, option) {
      this.inputs[question.id] = option;
      await this.answer(question);
    },

    async bet(prediction) {
      const value = this.inputs['p' + prediction.id];
      if (!value) return;
      await this.api('/api/predictions/bet', { predictionId: prediction.id, value: String(value) });
      this.fetchState();
    },

    async betChoice(prediction, option) {
      this.inputs['p' + prediction.id] = option;
      await this.bet(prediction);
    },

    async completeMission(mission) {
      await this.api('/api/missions/complete', { missionId: mission.id });
      this.fetchState();
    },

    missionState(mission) {
      if (!this.me || !this.me.teamId) return null;
      const done = mission.teams[String(this.me.teamId)];
      return done ? done.state : null;
    },

    async toggleCheck(item) {
      await this.api('/api/checklist/toggle', { id: item.id });
      this.fetchState();
    },

    async addCheck() {
      if (!this.newCheck) return;
      await this.api('/api/checklist/add', { text: this.newCheck, adminOnly: this.newCheckAdmin });
      this.newCheck = '';
      this.fetchState();
    },

    // Admin
    async setQuestionState(question, state) {
      await this.api('/api/admin/question/update', { id: question.id, state });
      this.fetchState();
    },

    async setAnswerKey(question) {
      const value = this.inputs['fasit' + question.id];
      if (value === undefined || value === '') return;
      await this.api('/api/admin/question/update', { id: question.id, answer: String(value) });
      this.fetchState();
    },

    async grade(answerEntry, correct) {
      await this.api('/api/admin/answer/grade', { answerId: answerEntry.id, correct });
      this.fetchState();
    },

    async lockPredictions() {
      if (!confirm('Låse alle spådommer? Ingen kan endre etterpå.')) return;
      await this.api('/api/admin/predictions/lock');
      this.fetchState();
    },

    async resolvePrediction(prediction) {
      const fasit = this.resolveInputs[prediction.id];
      if (!fasit) return;
      await this.api('/api/admin/prediction/resolve', { id: prediction.id, fasit: String(fasit) });
      this.fetchState();
    },

    async reviewMission(entry, approved) {
      await this.api('/api/admin/mission/review', { id: entry.id, approved });
      this.fetchState();
    },

    async givePreset(preset) {
      if (!this.scorePlayer) { this.error = 'Velg spiller først'; setTimeout(() => this.error = '', 2500); return; }
      await this.api('/api/admin/score', {
        playerId: this.scorePlayer, activity: preset.activity, label: preset.label, points: preset.points,
      });
    },

    async giveCustom() {
      if (!this.scorePlayer || !this.scoreCustomLabel) return;
      await this.api('/api/admin/score', {
        playerId: this.scorePlayer, activity: 'dagen',
        label: this.scoreCustomLabel, points: Number(this.scoreCustomPoints) || 0,
      });
      this.scoreCustomLabel = '';
    },

    async giveTeamScore(team, points, label) {
      await this.api('/api/admin/score', { teamId: team.id, activity: 'golf', label, points });
    },

    async deleteScore(entry) {
      if (!confirm('Slette «' + entry.label + '»?')) return;
      await this.api('/api/admin/score/delete', { id: entry.id });
    },

    async createTeam() {
      if (!this.newTeam) return;
      await this.api('/api/admin/team', { name: this.newTeam });
      this.newTeam = '';
      this.fetchState();
    },

    async assignTeam(playerEntry, event) {
      const value = event.target.value;
      await this.api('/api/admin/assign-team', {
        playerId: playerEntry.id, teamId: value ? Number(value) : null,
      });
      this.fetchState();
    },

    async addQuestion() {
      if (!this.newQ.quizId || !this.newQ.text) return;
      await this.api('/api/admin/question', {
        quizId: Number(this.newQ.quizId),
        text: this.newQ.text,
        type: this.newQ.type,
        options: this.newQ.options ? this.newQ.options.split(';').map((s) => s.trim()).filter(Boolean) : [],
        answer: this.newQ.answer,
        points: Number(this.newQ.points) || 5,
      });
      this.newQ.text = ''; this.newQ.options = ''; this.newQ.answer = '';
      this.fetchState();
    },

    teamName(teamId) {
      const team = (this.state?.teams || []).find((t) => t.id === teamId);
      return team ? team.name : '';
    },

    stateLabel(s) {
      return { hidden: 'Skjult', open: 'Åpent – svar nå!', revealed: 'Fasit klar' }[s] || s;
    },
  },

  async mounted() {
    await this.fetchState();
    this.connectWS();
    setInterval(() => this.fetchState(), 30000); // fallback ved død WS
  },

  template: `
  <div v-if="error" class="toast">{{ error }}</div>

  <!-- Registrering -->
  <div v-if="!me" class="register">
    <h1>🏌️‍♂️ Erling Open 🍷</h1>
    <p class="tag">Utdrikningslag · huskeliste · score · spådommer</p>
    <div class="card" v-if="state">
      <label>Hva heter du?</label>
      <input v-model="regName" placeholder="Navn" autocomplete="off">
      <label>Velg lagmerke</label>
      <div class="emoji-grid">
        <button v-for="e in ['🍺','🍷','🏌️','🥃','🎩','🕺','🦁','🐐','🚀','🎯','🤠','🧨']" :key="e"
          :class="{ selected: regEmoji === e }" @click="regEmoji = e">{{ e }}</button>
      </div>
      <label>Festkode</label>
      <input v-model="regCode" placeholder="Får du av arrangøren" autocomplete="off">
      <br><br>
      <button class="primary block" :disabled="!regName" @click="register">Bli med 🎉</button>
    </div>
  </div>

  <template v-else>
    <header class="app">
      <h1>🏌️‍♂️ Erling Open</h1>
      <div class="sub">{{ me.emoji }} {{ me.name }}<span v-if="myTeam"> · {{ myTeam.name }}</span><span v-if="isAdmin"> · Arrangør 👑</span></div>
    </header>

    <main>
      <!-- HJEM -->
      <template v-if="tab === 'hjem'">
        <div class="card">
          <h2>Kjøreplan</h2>
          <div v-for="(s, i) in state.schedule" :key="i" class="slot" :class="{ now: i === currentSlotIndex }">
            <div class="time">{{ s.time }}</div>
            <div class="what">{{ s.title }}<div class="where">{{ s.where }}</div></div>
            <div class="icon">{{ s.icon }}</div>
          </div>
        </div>
        <div class="card">
          <h2>Siste hendelser</h2>
          <p v-if="!state.feed.length" class="muted">Ingenting har skjedd ennå. Det endrer seg. 🍾</p>
          <div v-for="f in state.feed" :key="f.id" class="feed-item">
            <span>{{ f.who }}</span>
            <span class="muted">{{ f.label }}</span>
            <span class="pts" :class="f.points >= 0 ? 'pos' : 'neg'">{{ f.points > 0 ? '+' : '' }}{{ f.points }}</span>
            <button v-if="isAdmin" class="tight danger small" @click="deleteScore(f)">✕</button>
          </div>
        </div>
      </template>

      <!-- SPILL -->
      <template v-if="tab === 'spill'">
        <!-- Spådommer -->
        <div class="card">
          <h2>🔮 Erling prediction market</h2>
          <p class="muted small" v-if="openPredictions.length">Svar før golfen – så låses alt!</p>
          <div v-for="p in state.predictions" :key="p.id" class="q">
            <div class="status" :class="{ open: p.state === 'open' }">{{ p.state === 'open' ? 'Åpen' : p.state === 'locked' ? 'Låst 🔒' : 'Avgjort ✅' }} · {{ p.points }}p</div>
            <div class="qtext">{{ p.text }}</div>
            <template v-if="p.state === 'open'">
              <div v-if="p.type === 'choice'" class="options">
                <button v-for="o in p.options" :key="o" :class="{ selected: p.myBet === o }" @click="betChoice(p, o)">{{ o }}</button>
              </div>
              <div v-else class="row">
                <input v-model="inputs['p' + p.id]" :placeholder="p.type === 'time' ? 'F.eks. 12:45' : 'Tall'" :inputmode="p.type === 'time' ? 'numeric' : 'decimal'">
                <button class="tight primary" @click="bet(p)">Svar</button>
              </div>
              <div v-if="p.myBet" class="mine">Ditt svar: {{ p.myBet }}</div>
            </template>
            <template v-else>
              <div v-if="p.fasit" class="fasit">Fasit: {{ p.fasit }}</div>
              <div class="answers">
                <div v-for="b in p.bets || []" :key="b.who" class="a"><span>{{ b.who }}</span><span class="val">{{ b.value }}</span></div>
              </div>
              <div v-if="isAdmin && p.state === 'locked'" class="row" style="margin-top:8px">
                <input v-model="resolveInputs[p.id]" placeholder="Fasit">
                <button class="tight warn" @click="resolvePrediction(p)">Avgjør</button>
              </div>
            </template>
          </div>
          <button v-if="isAdmin && openPredictions.length" class="warn block" @click="lockPredictions">🔒 Lås alle spådommer</button>
        </div>

        <!-- Quizer -->
        <div v-for="quiz in state.quizzes" :key="quiz.id" class="card">
          <h2>{{ quiz.name }}</h2>
          <template v-for="q in quiz.questions" :key="q.id">
            <div v-if="q.state !== 'hidden' || isAdmin" class="q">
              <div class="status" :class="{ open: q.state === 'open' }">{{ stateLabel(q.state) }} · {{ q.points }}p</div>
              <div class="qtext">{{ q.text }}</div>

              <template v-if="q.state === 'open'">
                <div v-if="q.type === 'choice'" class="options">
                  <button v-for="o in q.options" :key="o" :class="{ selected: q.myAnswer === o }" @click="answerChoice(q, o)">{{ o }}</button>
                </div>
                <div v-else class="row">
                  <input v-model="inputs[q.id]" :placeholder="q.type === 'number' ? 'Tall' : 'Ditt svar'" :inputmode="q.type === 'number' ? 'decimal' : 'text'">
                  <button class="tight primary" @click="answer(q)">Svar</button>
                </div>
                <div v-if="q.myAnswer" class="mine">Ditt svar: {{ q.myAnswer }}</div>
              </template>

              <div v-if="q.state === 'revealed' && q.answer" class="fasit">Fasit: {{ q.answer }}</div>
              <div v-if="q.answers" class="answers">
                <div v-for="a in q.answers" :key="a.id" class="a">
                  <span>{{ a.who }}</span><span class="val">{{ a.value }}</span>
                  <span v-if="a.correct === true">✅</span><span v-else-if="a.correct === false">❌</span>
                  <span v-if="isAdmin && q.type === 'text'" class="grade">
                    <button @click="grade(a, true)">✓</button><button @click="grade(a, false)">✗</button>
                  </span>
                </div>
              </div>

              <div v-if="isAdmin" class="row" style="margin-top:10px">
                <button v-if="q.state === 'hidden'" class="primary" @click="setQuestionState(q, 'open')">Åpne</button>
                <button v-if="q.state === 'open'" class="warn" @click="setQuestionState(q, 'revealed')">Reveal 🎉</button>
                <button v-if="q.state !== 'hidden'" class="ghost" @click="setQuestionState(q, 'hidden')">Skjul</button>
              </div>
              <div v-if="isAdmin && !q.answer && q.type !== 'text'" class="row" style="margin-top:8px">
                <input v-model="inputs['fasit' + q.id]" placeholder="Sett fasit (skjult for andre)">
                <button class="tight ghost" @click="setAnswerKey(q)">Lagre</button>
              </div>
            </div>
          </template>
        </div>

        <!-- Fotooppdrag -->
        <div class="card">
          <h2>📸 Fotooppdrag</h2>
          <p v-if="!me.teamId" class="muted">Du er ikke på et lag ennå – arrangøren fikser.</p>
          <div v-for="m in state.missions" :key="m.id" class="checkitem">
            <div class="txt">{{ m.text }} <span class="muted small">({{ m.points }}p)</span>
              <div class="wrap" style="margin-top:2px">
                <span v-for="(d, tid) in m.teams" :key="tid" class="badge" :class="{ ok: d.state === 'approved', pending: d.state === 'pending' }">
                  {{ teamName(Number(tid)) }}: {{ d.state === 'approved' ? '✅' : d.state === 'pending' ? '⏳' : '❌' }}
                </span>
              </div>
            </div>
            <button v-if="me.teamId && !missionState(m)" class="tight primary" @click="completeMission(m)">Fullført!</button>
          </div>
          <template v-if="isAdmin && pendingMissions.length">
            <h3>Til godkjenning</h3>
            <div v-for="pm in pendingMissions" :key="pm.id" class="checkitem">
              <div class="txt">{{ pm.team }}: {{ pm.mission }}</div>
              <button class="tight primary" @click="reviewMission(pm, true)">✓</button>
              <button class="tight danger" @click="reviewMission(pm, false)">✗</button>
            </div>
          </template>
        </div>
      </template>

      <!-- SCORE -->
      <template v-if="tab === 'score'">
        <div class="card">
          <h2>🏆 Individuelt</h2>
          <div v-for="(p, i) in playersByScore" :key="p.id" class="lb-row" :class="{ me: p.id === me.id }">
            <div class="rank">{{ ['🥇','🥈','🥉'][i] || (i + 1) }}</div>
            <div>{{ p.emoji }} {{ p.name }}</div>
            <div class="total">{{ p.total }}</div>
          </div>
        </div>
        <div class="card" v-if="state.teams.length">
          <h2>🏴 Lag</h2>
          <p class="muted small">Lagpoeng + summen av lagets individuelle poeng</p>
          <div v-for="(t, i) in teamsByScore" :key="t.id" class="lb-row">
            <div class="rank">{{ ['🥇','🥈','🥉'][i] || (i + 1) }}</div>
            <div>{{ t.name }}</div>
            <div class="total">{{ t.total }}</div>
          </div>
        </div>
      </template>

      <!-- MER -->
      <template v-if="tab === 'mer'">
        <div class="card">
          <h2>📝 Huskeliste</h2>
          <div v-for="c in state.checklist" :key="c.id" class="checkitem" :class="{ done: c.done }">
            <button class="tight ghost" @click="toggleCheck(c)">{{ c.done ? '✅' : '⬜️' }}</button>
            <div class="txt">{{ c.text }} <span v-if="c.adminOnly" class="badge">arrangør</span>
              <div v-if="c.done && c.doneBy" class="muted small">✔ {{ c.doneBy }}</div>
            </div>
          </div>
          <div class="row" style="margin-top:8px">
            <input v-model="newCheck" placeholder="Ny huskelapp" @keyup.enter="addCheck">
            <button class="tight primary" @click="addCheck">+</button>
          </div>
          <label v-if="isAdmin" class="row" style="margin-top:6px"><input type="checkbox" v-model="newCheckAdmin" style="width:auto" class="tight"> <span>Kun for arrangører</span></label>
        </div>

        <div class="card" v-if="!isAdmin">
          <h2>👑 Arrangør?</h2>
          <div class="row">
            <input v-model="adminCode" placeholder="Arrangørkode" autocomplete="off">
            <button class="tight warn" @click="unlockAdmin">Lås opp</button>
          </div>
        </div>

        <template v-if="isAdmin">
          <div class="card">
            <h2>⛳️ Hurtigpoeng</h2>
            <label>Spiller</label>
            <select v-model.number="scorePlayer">
              <option :value="null" disabled>Velg spiller…</option>
              <option v-for="p in state.players" :key="p.id" :value="p.id">{{ p.emoji }} {{ p.name }}</option>
            </select>
            <div class="wrap" style="margin-top:10px">
              <button v-for="pr in state.scorePresets" :key="pr.label" @click="givePreset(pr)">{{ pr.label }} ({{ pr.points > 0 ? '+' : '' }}{{ pr.points }})</button>
            </div>
            <h3>Egendefinert</h3>
            <div class="row">
              <input v-model="scoreCustomLabel" placeholder="Beskrivelse">
              <input v-model="scoreCustomPoints" type="number" style="max-width:80px" class="tight">
              <button class="tight primary" @click="giveCustom">Gi</button>
            </div>
            <h3 v-if="state.teams.length">Lagpoeng</h3>
            <div v-for="t in state.teams" :key="t.id" class="row" style="margin-bottom:6px">
              <span>{{ t.name }}</span>
              <button class="tight" @click="giveTeamScore(t, 15, 'Lagseier PINPIN 🥇')">+15 golf</button>
              <button class="tight" @click="giveTeamScore(t, 5, 'Lagpoeng')">+5</button>
            </div>
          </div>

          <div class="card">
            <h2>🏴 Lag</h2>
            <div class="row">
              <input v-model="newTeam" placeholder="Nytt lagnavn">
              <button class="tight primary" @click="createTeam">Opprett</button>
            </div>
            <div v-for="p in state.players" :key="p.id" class="row" style="margin-top:6px">
              <span>{{ p.emoji }} {{ p.name }}</span>
              <select class="tight" style="max-width:150px" :value="p.teamId ?? ''" @change="assignTeam(p, $event)">
                <option value="">Uten lag</option>
                <option v-for="t in state.teams" :key="t.id" :value="t.id">{{ t.name }}</option>
              </select>
            </div>
          </div>

          <div class="card">
            <h2>➕ Nytt spørsmål</h2>
            <button class="ghost block" @click="showNewQ = !showNewQ">{{ showNewQ ? 'Skjul' : 'Vis skjema' }}</button>
            <template v-if="showNewQ">
              <label>Quiz</label>
              <select v-model="newQ.quizId">
                <option v-for="z in state.quizzes" :key="z.id" :value="z.id">{{ z.name }}</option>
              </select>
              <label>Spørsmål</label>
              <input v-model="newQ.text">
              <label>Type</label>
              <select v-model="newQ.type">
                <option value="choice">Flervalg</option>
                <option value="number">Tall (nærmest vinner)</option>
                <option value="text">Fritekst (rettes manuelt)</option>
              </select>
              <template v-if="newQ.type === 'choice'">
                <label>Alternativer (skill med ;)</label>
                <input v-model="newQ.options" placeholder="Vin 1; Vin 2; Vin 3">
              </template>
              <label>Fasit (kan settes senere)</label>
              <input v-model="newQ.answer">
              <label>Poeng</label>
              <input v-model="newQ.points" type="number">
              <br><br>
              <button class="primary block" @click="addQuestion">Legg til</button>
            </template>
          </div>
        </template>
      </template>
    </main>

    <nav class="tabs">
      <button :class="{ active: tab === 'hjem' }" @click="tab = 'hjem'"><span class="ico">🏠</span>Hjem</button>
      <button :class="{ active: tab === 'spill' }" @click="tab = 'spill'"><span class="ico">🎮</span>Spill</button>
      <button :class="{ active: tab === 'score' }" @click="tab = 'score'"><span class="ico">🏆</span>Score</button>
      <button :class="{ active: tab === 'mer' }" @click="tab = 'mer'"><span class="ico">⚙️</span>Mer</button>
    </nav>
  </template>
  `,
});

app.mount('#app');
