configured-sqs-client
==========================

![Node CI](https://github.com/gas-buddy/configured-sqs-client/workflows/Node%20CI/badge.svg)

A small wrapper around the AWS SQS sdk and sqs-consumer to allow configuration from confit.
Unlike configured-rabbitmq-client, most queue configuration for SQS is done OUTSIDE of the
infrastructure here (assumedly will be terraform or similar). So this module focuses on publishing
and consuming messages, but with as similar an configuration specification as possible.

Usage
=====
See the test directory for sample usage. To send a message, you must configure a logical queue, something like:

```
{
  region: 'us-east-1',
  queues: {
    basic: 'basic_queue'
  }
}
```

Now, you can publish to this queue using:

```
  configuredSqsClient.publish(req, 'basic', { some: 'message' });
```

To receive this message, you would subscribe:

```
  sqs.subscribe(context, 'basic', async (req, message, envelope) => {
    // Do stuff, await stuff, throw errors, whatever
  });
```
