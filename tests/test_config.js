import tap from 'tap';
import uuid from 'uuid/v4';
import SqsClient from '../src/index';

const sqsHost = process.env.SQS_HOST || 'localhost';
const sqsPort = process.env.SQS_PORT || 9324;

const qConfig = {
  region: 'us-east-1',
  endpoint: `http://${sqsHost}:${sqsPort}/`,
  queues: {
    basic: 'basic_queue',
    unreal: 'this_queue_does_not_exist',
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

tap.test('test_config', async (t) => {
  const messageId = uuid();
  const sqs = new SqsClient(ctx, qConfig);

  let doneAccept;
  const receivePromise = new Promise((accept) => { doneAccept = accept; });

  await sqs.subscribe(ctx, 'basic', (req, message) => {
    if (message.messageId === messageId) {
      t.ok(true, 'Should receive the message that was sent');
      t.strictEquals(req.headers.correlationid, ctx.headers.correlationid, 'Correlation ID should match');
      doneAccept();
    }
  });

  await sqs.start(ctx);

  await sqs.publish(ctx, 'basic', { test: true, messageId });
  t.ok(true, 'Should publish a message');

  try {
    await sqs.publish(ctx, 'foo', { test: true });
    t.notOk(true, 'Should throw for invalid logical queue');
  } catch (error) {
    t.strictEquals('InvalidQueue', error.code, 'Should throw for invalid logical queue');
  }

  try {
    await sqs.publish(ctx, 'unreal', { test: true });
    t.notOk(true, 'Should throw for invalid physical queue');
  } catch (error) {
    t.strictEquals('AWS.SimpleQueueService.NonExistentQueue', error.code, 'Should throw for invalid physical queue');
  }

  await receivePromise;
  await sqs.stop(ctx);
});
