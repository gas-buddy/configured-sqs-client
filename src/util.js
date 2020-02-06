export function normalizeQueueConfig(queues) {
  let queueArray = queues;
  if (!Array.isArray(queueArray)) {
    queueArray = Object.entries(queues).map(([logicalName, qConfig]) => {
      if (typeof qConfig === 'string') {
        return { logicalName, name: qConfig };
      }
      return { logicalName, ...qConfig };
    });
  }

  queueArray = queueArray.map(q => (typeof q === 'string' ? { name: q } : q));

  // Fix up any missing queues via deadLetter setting
  queueArray.filter(q => q.deadLetter).forEach((q) => {
    if (!queueArray.find(exQ => (exQ.logicalName || exQ.name) === q.deadLetter)) {
      queueArray.push({ name: q.deadLetter });
    }
  });
  return queueArray;
}
