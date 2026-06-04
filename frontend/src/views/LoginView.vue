<template>
  <div class="login-layout">
    <div class="login-card">
      <div class="login-logo">◈</div>
      <h1 class="login-title">Image Analysis<br>Orchestration</h1>
      <p class="login-sub">Admin access required</p>

      <form class="login-form" @submit.prevent="submit">
        <div class="field">
          <label class="field-label">Username</label>
          <input
            v-model="username"
            type="text"
            class="field-input"
            autocomplete="username"
            autocapitalize="none"
            :disabled="loading"
            required
          />
        </div>
        <div class="field">
          <label class="field-label">Password</label>
          <input
            v-model="password"
            type="password"
            class="field-input"
            autocomplete="current-password"
            :disabled="loading"
            required
          />
        </div>

        <div v-if="error" class="login-error">{{ error }}</div>

        <button type="submit" class="login-btn" :disabled="loading">
          {{ loading ? 'Signing in…' : 'Sign in' }}
        </button>
      </form>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { login } from '../services/auth'

const router   = useRouter()
const username = ref('')
const password = ref('')
const loading  = ref(false)
const error    = ref('')

async function submit() {
  error.value = ''
  loading.value = true
  try {
    await login(username.value, password.value)
    router.push('/')
  } catch (e: any) {
    error.value = e.message ?? 'Login failed'
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
.login-layout {
  min-height: 100vh;
  display: flex; align-items: center; justify-content: center;
  background: var(--bg);
  padding: 1.5rem;
}

.login-card {
  width: 100%; max-width: 360px;
  display: flex; flex-direction: column; align-items: center;
  gap: 1rem;
}

.login-logo {
  font-size: 2.5rem; color: var(--amber);
  animation: pulse 3s ease-in-out infinite;
}

.login-title {
  font-family: var(--serif); font-size: 1.75rem; line-height: 1.2;
  text-align: center; color: var(--text);
}

.login-sub {
  font-size: 11px; letter-spacing: .1em; text-transform: uppercase;
  color: var(--text-muted);
}

.login-form {
  width: 100%; display: flex; flex-direction: column; gap: .9rem;
  margin-top: .5rem;
}

.field { display: flex; flex-direction: column; gap: .35rem; }
.field-label {
  font-size: 10px; letter-spacing: .1em; text-transform: uppercase;
  color: var(--text-muted);
}
.field-input {
  background: var(--bg-raised); border: 1px solid var(--border-mid);
  border-radius: 3px; padding: .7rem .9rem;
  font-family: var(--mono); font-size: 13px; color: var(--text);
  outline: none; transition: border-color .15s;
  width: 100%;
}
.field-input:focus { border-color: var(--amber); }
.field-input:disabled { opacity: .5; }

.login-error {
  font-size: 11px; color: var(--red);
  padding: .6rem .75rem;
  background: rgba(224,85,85,.08);
  border: 1px solid rgba(224,85,85,.25);
  border-radius: 3px;
}

.login-btn {
  width: 100%; padding: .85rem;
  background: var(--amber); color: #0a0a0a;
  border: none; border-radius: 3px;
  font-family: var(--mono); font-size: 13px; font-weight: 500;
  letter-spacing: .06em; text-transform: uppercase;
  cursor: pointer; transition: opacity .2s;
  margin-top: .25rem;
}
.login-btn:hover:not(:disabled) { opacity: .88; }
.login-btn:disabled { opacity: .4; cursor: not-allowed; }
</style>
