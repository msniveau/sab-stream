<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import Leaderboard from './components/Leaderboard.vue';
import PathVisualizer3D from './components/PathVisualizer3D.vue';

const currentView = ref<'leaderboard' | 'visualizer'>('leaderboard');

function switchView() {
  currentView.value = currentView.value === 'leaderboard' ? 'visualizer' : 'leaderboard';
}

function handleKeyDown(e: KeyboardEvent) {
  // Tab key to toggle view
  if (e.key === 'Tab') {
    e.preventDefault();
    e.stopPropagation();
    switchView();
  }
}

onMounted(() => {
  // Use capture phase to catch before any child elements
  window.addEventListener('keydown', handleKeyDown, { capture: true });
});

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeyDown, { capture: true });
});
</script>

<template>
  <div class="app-container">
    <Leaderboard v-if="currentView === 'leaderboard'" @switch-view="switchView" />
    <PathVisualizer3D v-else @back-to-leaderboard="currentView = 'leaderboard'" />
  </div>
</template>

<style>
body {
  margin: 0;
  display: flex;
  place-items: center;
  min-width: 100vw;
  min-height: 100vh;
  background-color: black;
}

#app {
  width: 100%;
  margin: 0;
  padding: 0;
  text-align: center;
}

.app-container {
  position: relative;
  width: 100%;
  height: 100vh;
}
</style>
