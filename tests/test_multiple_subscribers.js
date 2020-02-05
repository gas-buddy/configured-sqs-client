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
  queues: ['second_queue'],
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
  const message2Id = uuid();

  const sqs = new SqsClient(ctx, qConfig);

  const { accept: firstAccept, promise: firstPromise } = getPromiseAcceptor();
  const { accept: secondAccept, promise: secondPromise } = getPromiseAcceptor();

  let completedProcessing;

  await sqs.subscribe(ctx, 'second_queue', async (req, message) => {
    if (message.message1Id === message1Id) {
      t.notOk(completedProcessing, 'Should not receive the first message after processing was completed');
      t.ok(true, 'Should receive the first message that was sent');
      await new Promise(accept => setTimeout(accept, 500));
      completedProcessing = true;
      firstAccept();
    } else if (message.message2Id === message2Id) {
      t.notOk(completedProcessing, 'Should not receive the second message after processing was completed');
      t.ok(true, 'Should receive the second message that was sent');
      await new Promise(accept => setTimeout(accept, 500));
      completedProcessing = true;
      secondAccept();
    }
  }, { readers: 2 });

  await sqs.start(ctx);

  await Promise.all([
    sqs.publish(ctx, 'second_queue', { test: true, message1Id }),
    sqs.publish(ctx, 'second_queue', { test: true, message2Id }),
    firstPromise,
    secondPromise,
  ]);

  await sqs.stop(ctx);
});
