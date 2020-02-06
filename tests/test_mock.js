import tap from 'tap';
import uuid from 'uuid/v4';
import { MockSQSClient } from '../src/MockSQSClient';

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
  queues: [{ name: 'second_queue', readers: 2 }],
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
    wrapError(e) { return e; },
  },
};

function getPromiseAcceptor() {
  let acceptReturn;
  const promise = new Promise((accept) => { acceptReturn = accept; });
  return { accept: acceptReturn, promise };
}

tap.test('test_multiple_subscribers', async (t) => {
  const message1Id = uuid();

  const sqs = new MockSQSClient(ctx, qConfig);

  const { accept: firstAccept, promise: firstPromise } = getPromiseAcceptor();

  await sqs.subscribe(ctx, 'second_queue', async (req, message) => {
    if (message.message1Id === message1Id) {
      t.ok(true, 'Should receive the first message that was sent');
      firstAccept();
    }
  });

  await sqs.start(ctx);

  await Promise.all([
    sqs.publish(ctx, 'second_queue', { test: true, message1Id }),
    firstPromise,
  ]);

  await sqs.stop(ctx);
});
