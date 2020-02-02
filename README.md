configured-sqs-client
==========================
A small wrapper around the AWS SQS sdk and sqs-consumer to allow configuration from confit.
Unlike configured-rabbitmq-client, most queue configuration for SQS is done OUTSIDE of the
infrastructure here (assumedly will be terraform or similar). So this module focuses on publishing
and consuming messages, but with as similar an configuration specification as possible.
