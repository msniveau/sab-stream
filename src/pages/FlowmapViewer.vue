<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { simplifyFlowmap, SimplifiedFlowmap } from '../logic/flowmap-simplifier';
import flowmapJson from '../../flowmap.json';

const simplifiedData = ref<SimplifiedFlowmap>({});
const jsonOutput = ref('');

onMounted(() => {
  simplifiedData.value = simplifyFlowmap(flowmapJson);
  jsonOutput.value = JSON.stringify(simplifiedData.value, null, 2);
  console.log('Simplified Flowmap:', simplifiedData.value);
});

const downloadJson = () => {
  const blob = new Blob([jsonOutput.value], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'simplified-flowmap.json';
  a.click();
  URL.revokeObjectURL(url);
};
</script>

<template>
  <div class="flowmap-viewer">
    <h1>Simplified Flowmap</h1>
    <p>Total Checkpoints: {{ Object.keys(simplifiedData).length }}</p>
    <button @click="downloadJson" class="download-btn">Download JSON</button>
    <pre class="json-output">{{ jsonOutput }}</pre>
  </div>
</template>

<style scoped>
.flowmap-viewer {
  padding: 20px;
  background: #0e1014;
  color: #fff;
  min-height: 100vh;
  font-family: monospace;
}

h1 {
  color: #ffcc00;
  margin-bottom: 10px;
}

p {
  color: #aaa;
  margin-bottom: 20px;
}

.download-btn {
  background: #444;
  color: white;
  border: none;
  padding: 10px 20px;
  border-radius: 4px;
  cursor: pointer;
  margin-bottom: 20px;
}

.download-btn:hover {
  background: #555;
}

.json-output {
  background: #1a1a1a;
  border: 1px solid #333;
  border-radius: 4px;
  padding: 15px;
  overflow: auto;
  max-height: 80vh;
  font-size: 12px;
  line-height: 1.5;
}
</style>
