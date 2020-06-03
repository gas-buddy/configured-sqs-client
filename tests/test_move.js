import tap from 'tap';
import uuid from 'uuid/v4';
import SqsClient from '../src/index';

const sqsHost = process.env.SQS_HOST || 'localhost';
const sqsPort = process.env.SQS_PORT || 9324;

const qConfig = {
  region: 'us-east-1',
  endpoint: {
    // ElasticMQ wants "queue" there rather than an account id
    endpoint: `http://${sqsHost}:${sqsPort}/queue`,
    accessKeyId: 'key',
    secretAccessKey: 'secret',
    sessionToken: 'token',
  },
  queues: {
    basic: 'basic_queue',
    dead: 'dead_letter_queue',
  },
  subscriptions: {
    waitTimeSeconds: 1,
  },
  contextFunction(context, message) {
    return {
      ...context,
      headers: { correlationid: message?.MessageAttributes?.CorrelationId?.StringValue },
    };
  },
};

const ctx = {
  logger: console,
  headers: { correlationid: uuid() },
  service: {
    wrapError(e, args = {}) { return Object.assign(e, args); },
  },
};

tap.test('test_move', async (t) => {
  const messageId = uuid();
  const sqs = new SqsClient(ctx, qConfig);

  await sqs.start(ctx);

  await Promise.all([1, 2, 3, 4, 5].map(count => sqs.publish(ctx, 'dead', { test: true, messageId, count })));
  t.ok(true, 'Should publish 5 messages');

  const count = await sqs.moveMessages(ctx, 'dead_letter_queue', 'basic_queue', 5);
  t.strictEquals(count, 5, 'Should move 5 messages');

  await sqs.stop(ctx);
  t.ok(true, 'Should stop the client');
});
