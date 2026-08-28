import { createApp } from './vue.esm-browser.prod.js';

let fetchTimer = null;

const app = createApp({
  data() {
    return {
      token: localStorage.getItem('erlingToken') || '',
      state: null,
      tab: 'hjem',
      error: '',
      displayMode: new URLSearchParams(window.location.search).get('display') === 'quiz',
      clockNow: Date.now(),
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
      quizDurations: {},
      uploadingQuestion: null,
      newQ: { quizId: null, text: '', type: 'choice', options: '', answer: '', points: 5, mediaUrl: '', mediaType: '' },
      showNewQ: false,
      // Question and quiz-name edits live in local drafts so the refetch every
      // WebSocket poke triggers cannot wipe what the organizer is typing.
      questionDrafts: {},
      quizNameDrafts: {},
      newQuizName: '',
      newMission: { text: '', points: 10 },
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
    activeQuiz() {
      return (this.state?.quizzes || []).find((quiz) => quiz.status === 'active' || quiz.status === 'expired') || null;
    },
    displayQuestion() {
      if (!this.activeQuiz || !this.activeQuiz.currentQuestionId) return null;
      return this.activeQuiz.questions.find((question) => question.id === this.activeQuiz.currentQuestionId) || null;
    },
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
      if (res.ok) {
        this.state = await res.json();
        this.clockNow = Date.now();
        for (const quiz of this.state.quizzes || []) {
          if (this.quizNameDrafts[quiz.id] === undefined) {
            this.quizNameDrafts[quiz.id] = quiz.name;
          }
          if (this.quizDurations[quiz.id] === undefined) {
            this.quizDurations[quiz.id] = quiz.durationSeconds ? quiz.durationSeconds / 60 : 10;
          }
          for (const question of quiz.questions || []) {
            if (this.questionDrafts[question.id] === undefined) {
              this.questionDrafts[question.id] = {
                text: question.text,
                type: question.type,
                options: (question.options || []).join('; '),
                answer: question.answer || '',
                points: question.points,
              };
            }
          }
        }
      }
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
        options: this.splitOptions(this.newQ.options),
        answer: this.newQ.answer,
        points: Number(this.newQ.points) || 5,
        mediaUrl: this.newQ.mediaUrl,
        mediaType: this.newQ.mediaType,
      });
      this.newQ.text = ''; this.newQ.options = ''; this.newQ.answer = '';
      this.newQ.mediaUrl = ''; this.newQ.mediaType = '';
      this.fetchState();
    },

    async addQuiz() {
      const name = this.newQuizName.trim();
      if (!name) return;
      const created = await this.api('/api/admin/quiz', { name });
      this.newQuizName = '';
      await this.fetchState();
      this.newQ.quizId = created.id;
      this.showNewQ = true;
    },

    async saveQuizName(quiz) {
      const name = (this.quizNameDrafts[quiz.id] || '').trim();
      if (!name) {
        this.error = 'Quizen må ha et navn';
        setTimeout(() => { this.error = ''; }, 2500);
        return;
      }
      await this.api('/api/admin/quiz/update', { id: quiz.id, name });
      this.fetchState();
    },

    async deleteQuiz(quiz) {
      if (!confirm(`Slette «${quiz.name}» med ${quiz.questions.length} spørsmål? `
        + 'Svar og poeng for quizen forsvinner også.')) return;
      await this.api('/api/admin/quiz/delete', { id: quiz.id });
      delete this.quizNameDrafts[quiz.id];
      for (const question of quiz.questions) delete this.questionDrafts[question.id];
      if (this.newQ.quizId === quiz.id) this.showNewQ = false;
      this.fetchState();
    },

    async saveQuestion(question) {
      const draft = this.questionDrafts[question.id];
      if (!draft.text.trim()) {
        this.error = 'Spørsmålet kan ikke være tomt';
        setTimeout(() => { this.error = ''; }, 2500);
        return;
      }
      await this.api('/api/admin/question/update', {
        id: question.id,
        text: draft.text,
        type: draft.type,
        options: this.splitOptions(draft.options),
        answer: draft.answer,
        points: Number(draft.points) || 0,
      });
      this.fetchState();
    },

    async deleteQuestion(question) {
      const warning = question.answerCount
        ? `Slette spørsmålet? ${question.answerCount} svar og poengene for dem forsvinner også.`
        : 'Slette spørsmålet?';
      if (!confirm(warning)) return;
      await this.api('/api/admin/question/delete', { id: question.id });
      delete this.questionDrafts[question.id];
      this.fetchState();
    },

    toggleNewQuestion(quiz) {
      this.showNewQ = !(this.showNewQ && this.newQ.quizId === quiz.id);
      this.newQ.quizId = quiz.id;
    },

    splitOptions(text) {
      return text ? text.split(';').map((o) => o.trim()).filter(Boolean) : [];
    },

    async revealSchedule(item, revealed) {
      await this.api('/api/admin/schedule/reveal', { id: item.id, revealed });
      this.fetchState();
    },

    async saveSchedule(item) {
      await this.api('/api/admin/schedule/update', {
        id: item.id, time: item.time, title: item.title, where: item.where, icon: item.icon,
      });
      this.fetchState();
    },

    async startQuiz(quiz) {
      const minutes = Number(this.quizDurations[quiz.id]);
      if (!Number.isFinite(minutes) || minutes <= 0) {
        this.error = 'Velg en quizvarighet';
        setTimeout(() => { this.error = ''; }, 2500);
        return;
      }
      if ((quiz.status === 'active' || quiz.status === 'expired')
          && !confirm('Starte quizen og tidtakeren på nytt?')) return;
      await this.api('/api/admin/quiz/control', {
        id: quiz.id, action: 'start', durationSeconds: Math.max(1, Math.round(minutes * 60)),
      });
      this.tab = 'spill';
      this.fetchState();
    },

    async stopQuiz(quiz) {
      if (!confirm('Avslutte quizen nå? Deltakerne kan ikke svare videre.')) return;
      await this.api('/api/admin/quiz/control', { id: quiz.id, action: 'stop' });
      this.fetchState();
    },

    quizRemaining(quiz) {
      if (!quiz || !quiz.endsAt) return 0;
      return Math.max(0, Math.ceil(quiz.endsAt - this.clockNow / 1000));
    },

    formatCountdown(seconds) {
      const safe = Math.max(0, Number(seconds) || 0);
      const minutes = Math.floor(safe / 60);
      const rest = safe % 60;
      return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
    },

    questionTimedOut(question) {
      const quiz = (this.state?.quizzes || []).find((entry) => entry.questions.some((q) => q.id === question.id));
      return !!quiz && (quiz.status === 'expired' || (quiz.status === 'active' && this.quizRemaining(quiz) === 0));
    },

    openPresentation() {
      window.open('/?display=quiz', '_blank', 'noopener');
    },

    async toggleFullscreen() {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen?.();
      } else {
        await document.exitFullscreen?.();
      }
    },

    async uploadMedia(file) {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch('/api/admin/media', {
        method: 'POST', headers: { 'X-Token': this.token }, body: form,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Kunne ikke laste opp filen');
      return data;
    },

    async uploadQuestionMedia(question, event) {
      const file = event.target.files?.[0];
      if (!file) return;
      this.uploadingQuestion = question.id;
      try {
        const media = await this.uploadMedia(file);
        await this.api('/api/admin/question/update', {
          id: question.id, mediaUrl: media.url, mediaType: media.type,
        });
        await this.fetchState();
      } catch (err) {
        this.error = err.message;
        setTimeout(() => { this.error = ''; }, 3500);
      } finally {
        this.uploadingQuestion = null;
        event.target.value = '';
      }
    },

    async uploadNewQuestionMedia(event) {
      const file = event.target.files?.[0];
      if (!file) return;
      this.uploadingQuestion = 'new';
      try {
        const media = await this.uploadMedia(file);
        this.newQ.mediaUrl = media.url;
        this.newQ.mediaType = media.type;
      } catch (err) {
        this.error = err.message;
        setTimeout(() => { this.error = ''; }, 3500);
      } finally {
        this.uploadingQuestion = null;
        event.target.value = '';
      }
    },

    async removeQuestionMedia(question) {
      await this.api('/api/admin/question/update', { id: question.id, mediaUrl: '', mediaType: '' });
      this.fetchState();
    },

    async addMission() {
      if (!this.newMission.text) return;
      await this.api('/api/admin/mission', {
        text: this.newMission.text, points: Number(this.newMission.points) || 10,
      });
      this.newMission = { text: '', points: 10 };
      this.fetchState();
    },

    async saveMission(mission) {
      await this.api('/api/admin/mission/update', {
        id: mission.id, text: mission.text, points: Number(mission.points),
      });
      this.fetchState();
    },

    teamName(teamId) {
      const team = (this.state?.teams || []).find((t) => t.id === teamId);
      return team ? team.name : '';
    },

    quizName(quizId) {
      const quiz = (this.state?.quizzes || []).find((z) => z.id === quizId);
      return quiz ? quiz.name : '';
    },

    quizStatusLabel(quiz) {
      return { idle: 'ikke startet', active: 'pågår', expired: 'tiden er ute', finished: 'avsluttet' }[quiz.status]
        || quiz.status;
    },

    stateLabel(s) {
      return { hidden: 'Skjult', open: 'Åpent – svar nå!', revealed: 'Fasit klar' }[s] || s;
    },
  },

  async mounted() {
    await this.fetchState();
    this.connectWS();
    setInterval(() => { this.clockNow = Date.now(); }, 1000);
    setInterval(() => this.fetchState(), 30000); // fallback ved død WS
  },

  template: `
  <div v-if="error" class="toast">{{ error }}</div>

  <!-- Presentasjonsmodus for laptop/iPad/projektor -->
  <div v-if="displayMode" class="quiz-display">
    <div class="display-topbar">
      <div class="display-brand">🏌️ Erling Open</div>
      <button class="ghost" @click="toggleFullscreen">Fullskjerm ⛶</button>
    </div>
    <div v-if="!state" class="display-waiting">Laster quiz…</div>
    <div v-else-if="!activeQuiz" class="display-waiting">
      <div class="display-emoji">🧠</div>
      <h1>Venter på neste quiz</h1>
      <p>Start en quiz fra arrangørpanelet.</p>
    </div>
    <template v-else>
      <div class="display-meta">
        <div>
          <div class="display-kicker">LIVE QUIZ</div>
          <h1>{{ activeQuiz.name }}</h1>
        </div>
        <div class="quiz-timer" :class="{ expired: quizRemaining(activeQuiz) === 0 }">
          <span>{{ quizRemaining(activeQuiz) === 0 ? 'TIDEN ER UTE' : 'TID IGJEN' }}</span>
          {{ formatCountdown(quizRemaining(activeQuiz)) }}
        </div>
      </div>
      <div v-if="displayQuestion" class="display-question">
        <div class="display-question-number">
          Spørsmål {{ activeQuiz.questions.findIndex((q) => q.id === displayQuestion.id) + 1 }} av {{ activeQuiz.questions.length }}
          <span>· {{ displayQuestion.points }} poeng</span>
        </div>
        <div v-if="displayQuestion.mediaUrl" class="question-media display-media">
          <img v-if="displayQuestion.mediaType === 'image'" :src="displayQuestion.mediaUrl" alt="Bilde til spørsmålet">
          <video v-else-if="displayQuestion.mediaType === 'video'" :src="displayQuestion.mediaUrl" controls playsinline></video>
        </div>
        <h2>{{ displayQuestion.text }}</h2>
        <div v-if="displayQuestion.type === 'choice' && displayQuestion.state !== 'revealed'" class="display-options">
          <div v-for="(option, index) in displayQuestion.options" :key="option">
            <span>{{ String.fromCharCode(65 + index) }}</span>{{ option }}
          </div>
        </div>
        <div v-if="displayQuestion.state === 'revealed' && displayQuestion.answer" class="display-answer">
          <span>Fasit</span>{{ displayQuestion.answer }}
        </div>
        <div class="display-response-count">{{ displayQuestion.answerCount }} svar mottatt</div>
      </div>
      <div v-else class="display-waiting">
        <div class="display-emoji">✨</div>
        <h2>Quizen er i gang</h2>
        <p>Spørsmålet kommer straks.</p>
      </div>
    </template>
  </div>

  <!-- Registrering -->
  <div v-else-if="!me" class="register">
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
          <div v-for="(s, i) in state.schedule" :key="i" class="slot" :class="{ now: i === currentSlotIndex, secret: !s.revealed }">
            <div class="time">{{ s.time }}</div>
            <div v-if="s.revealed" class="what">{{ s.title }}<div class="where">{{ s.where }}</div></div>
            <div v-else class="what muted">Ikke avslørt ennå<div class="where" v-if="isAdmin">{{ s.title }}</div></div>
            <div class="icon">{{ s.revealed ? s.icon : '🤫' }}</div>
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
          <p class="muted small" v-if="openPredictions.length">Svar før kl 11 – så låses alt!</p>
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
        <div v-for="quiz in state.quizzes" :key="quiz.id" class="card quiz-card" :class="{ active: quiz.status === 'active' }">
          <div class="quiz-heading">
            <h2>{{ quiz.name }}</h2>
            <div v-if="quiz.status === 'active' || quiz.status === 'expired'" class="quiz-timer compact" :class="{ expired: quizRemaining(quiz) === 0 }">
              <span>{{ quizRemaining(quiz) === 0 ? 'Tiden er ute' : 'Tid igjen' }}</span>
              {{ formatCountdown(quizRemaining(quiz)) }}
            </div>
          </div>
          <div v-if="isAdmin" class="quiz-control">
            <div class="row">
              <label class="duration-field">Varighet (min)
                <input v-model="quizDurations[quiz.id]" type="number" min="0.1" step="0.5">
              </label>
              <button class="tight primary" @click="startQuiz(quiz)">{{ quiz.status === 'active' || quiz.status === 'expired' ? 'Start på nytt' : 'Start quiz' }}</button>
            </div>
            <div class="row quiz-control-actions">
              <button class="ghost" @click="openPresentation">Åpne visning ↗</button>
              <button v-if="quiz.status === 'active'" class="danger" @click="stopQuiz(quiz)">Avslutt</button>
            </div>
          </div>
          <template v-for="q in quiz.questions" :key="q.id">
            <div v-if="q.state !== 'hidden' || isAdmin" class="q">
              <div class="status" :class="{ open: q.state === 'open' }">{{ stateLabel(q.state) }} · {{ q.points }}p</div>
              <div class="qtext">{{ q.text }}</div>
              <div v-if="q.mediaUrl" class="question-media">
                <img v-if="q.mediaType === 'image'" :src="q.mediaUrl" alt="Bilde til spørsmålet">
                <video v-else-if="q.mediaType === 'video'" :src="q.mediaUrl" controls playsinline></video>
              </div>

              <template v-if="q.state === 'open'">
                <div v-if="questionTimedOut(q)" class="time-up">Tiden er ute – svarene er låst.</div>
                <template v-else>
                  <div v-if="q.type === 'choice'" class="options">
                    <button v-for="o in q.options" :key="o" :class="{ selected: q.myAnswer === o }" @click="answerChoice(q, o)">{{ o }}</button>
                  </div>
                  <div v-else class="row">
                    <input v-model="inputs[q.id]" :placeholder="q.type === 'number' ? 'Tall' : 'Ditt svar'" :inputmode="q.type === 'number' ? 'decimal' : 'text'">
                    <button class="tight primary" @click="answer(q)">Svar</button>
                  </div>
                  <div v-if="q.myAnswer" class="mine">Ditt svar: {{ q.myAnswer }}</div>
                </template>
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
                <button v-if="q.state === 'hidden'" class="primary" :disabled="quiz.status !== 'active'" @click="setQuestionState(q, 'open')">Åpne</button>
                <button v-if="q.state === 'open'" class="warn" @click="setQuestionState(q, 'revealed')">Vis fasit 🎉</button>
                <button v-if="q.state !== 'hidden'" class="ghost" @click="setQuestionState(q, 'hidden')">Skjul</button>
              </div>
              <div v-if="isAdmin && !q.answer && q.type !== 'text'" class="row" style="margin-top:8px">
                <input v-model="inputs['fasit' + q.id]" placeholder="Sett fasit (skjult for andre)">
                <button class="tight ghost" @click="setAnswerKey(q)">Lagre</button>
              </div>
              <div v-if="isAdmin" class="media-admin">
                <label class="btn ghost media-upload">
                  {{ uploadingQuestion === q.id ? 'Laster opp…' : q.mediaUrl ? 'Bytt bilde/video' : 'Legg til bilde/video' }}
                  <input type="file" accept="image/jpeg,image/png,image/gif,image/webp,video/mp4,video/webm,video/ogg,video/quicktime" :disabled="uploadingQuestion !== null" @change="uploadQuestionMedia(q, $event)">
                </label>
                <button v-if="q.mediaUrl" class="tight ghost" @click="removeQuestionMedia(q)">Fjern</button>
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
            <h2>📍 Rediger kjøreplan</h2>
            <p class="muted small">Endringer vises hos alle med én gang. Gjestene ser bare
              klokkeslettet til du avslører aktiviteten.</p>
            <div v-for="item in state.schedule" :key="item.id" class="admin-editor schedule-editor">
              <div class="row">
                <input v-model="item.time" type="time" class="schedule-time" aria-label="Tid">
                <input v-model="item.icon" class="schedule-icon" maxlength="8" aria-label="Ikon">
              </div>
              <input v-model="item.title" placeholder="Aktivitet">
              <input v-model="item.where" placeholder="Sted eller adresse">
              <div class="row">
                <span class="reveal-state" :class="item.revealed ? 'shown' : 'hidden'">
                  {{ item.revealed ? '👀 Avslørt' : '🤫 Skjult' }}
                </span>
                <button class="tight" :class="item.revealed ? 'warn' : 'primary'"
                        @click="revealSchedule(item, !item.revealed)">
                  {{ item.revealed ? 'Skjul igjen' : 'Avslør nå' }}
                </button>
              </div>
              <button class="primary block" @click="saveSchedule(item)">Lagre aktivitet</button>
            </div>
          </div>

          <div class="card">
            <h2>📸 Administrer fotooppdrag</h2>
            <div v-for="mission in state.missions" :key="mission.id" class="admin-editor mission-editor">
              <input v-model="mission.text" placeholder="Oppdrag">
              <div class="row">
                <label class="points-field">Poeng
                  <input v-model.number="mission.points" type="number" min="0">
                </label>
                <button class="tight primary" @click="saveMission(mission)">Lagre</button>
              </div>
            </div>
            <h3>Nytt oppdrag</h3>
            <input v-model="newMission.text" placeholder="Beskriv oppdraget">
            <div class="row">
              <label class="points-field">Poeng
                <input v-model.number="newMission.points" type="number" min="0">
              </label>
              <button class="tight primary" @click="addMission">Legg til</button>
            </div>
          </div>

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
            <h2>🧠 Rediger quiz</h2>
            <p class="muted small">Endringer vises hos alle med én gang. Fasit er skjult for spillerne
              til du viser den – retter du fasit etter at den er vist, regnes poengene om.</p>
            <div v-for="quiz in state.quizzes" :key="quiz.id" class="quiz-editor">
              <div class="row quiz-name-row">
                <input v-model="quizNameDrafts[quiz.id]" aria-label="Quiznavn">
                <button class="tight primary" @click="saveQuizName(quiz)">Lagre</button>
                <button class="tight danger" @click="deleteQuiz(quiz)">Slett quiz</button>
              </div>
              <p class="muted small">{{ quiz.questions.length }} spørsmål · {{ quizStatusLabel(quiz) }}</p>
              <p v-if="!quiz.questions.length" class="muted small">Ingen spørsmål ennå.</p>
              <div v-for="q in quiz.questions" :key="q.id" class="admin-editor question-editor">
                <div class="question-meta muted small">{{ stateLabel(q.state) }} · {{ q.answerCount }} svar</div>
                <input v-model="questionDrafts[q.id].text" placeholder="Spørsmål">
                <div class="row">
                  <select v-model="questionDrafts[q.id].type" class="tight">
                    <option value="choice">Flervalg</option>
                    <option value="number">Tall</option>
                    <option value="text">Fritekst</option>
                  </select>
                  <label class="points-field">Poeng
                    <input v-model.number="questionDrafts[q.id].points" type="number" min="0">
                  </label>
                </div>
                <input v-if="questionDrafts[q.id].type === 'choice'" v-model="questionDrafts[q.id].options"
                       placeholder="Alternativer (skill med ;)">
                <input v-model="questionDrafts[q.id].answer" placeholder="Fasit (skjult til du viser den)">
                <div class="media-admin">
                  <label class="btn ghost media-upload">
                    {{ uploadingQuestion === q.id ? 'Laster opp…' : q.mediaUrl ? 'Bytt bilde/video' : 'Legg til bilde/video' }}
                    <input type="file" accept="image/jpeg,image/png,image/gif,image/webp,video/mp4,video/webm,video/ogg,video/quicktime" :disabled="uploadingQuestion !== null" @change="uploadQuestionMedia(q, $event)">
                  </label>
                  <button v-if="q.mediaUrl" class="tight ghost" @click="removeQuestionMedia(q)">Fjern medie</button>
                </div>
                <div class="row">
                  <button class="tight primary" @click="saveQuestion(q)">Lagre</button>
                  <button class="tight danger" @click="deleteQuestion(q)">Slett</button>
                </div>
              </div>
              <button class="ghost block" @click="toggleNewQuestion(quiz)">
                {{ showNewQ && newQ.quizId === quiz.id ? 'Avbryt' : '➕ Nytt spørsmål' }}
              </button>
            </div>

            <h3>Ny quiz</h3>
            <div class="row">
              <input v-model="newQuizName" placeholder="Navn på quizen" @keyup.enter="addQuiz">
              <button class="tight primary" @click="addQuiz">Opprett</button>
            </div>

            <template v-if="showNewQ">
              <h3>Nytt spørsmål i «{{ quizName(newQ.quizId) }}»</h3>
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
              <label>Bilde eller video (valgfritt)</label>
              <label class="btn ghost media-upload block">
                {{ uploadingQuestion === 'new' ? 'Laster opp…' : newQ.mediaUrl ? 'Medie lagt til ✓' : 'Velg fil' }}
                <input type="file" accept="image/jpeg,image/png,image/gif,image/webp,video/mp4,video/webm,video/ogg,video/quicktime" :disabled="uploadingQuestion !== null" @change="uploadNewQuestionMedia">
              </label>
              <div v-if="newQ.mediaUrl" class="question-media preview-media">
                <img v-if="newQ.mediaType === 'image'" :src="newQ.mediaUrl" alt="Forhåndsvisning">
                <video v-else :src="newQ.mediaUrl" controls playsinline></video>
                <button class="tight ghost" @click="newQ.mediaUrl = ''; newQ.mediaType = ''">Fjern</button>
              </div>
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
