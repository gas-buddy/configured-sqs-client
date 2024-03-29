1.0.0
=====
* Everything changes.

1.1.0
=====
* Returning an error with a property deadLetter set to true or the logical name of another queue will publish the original message with a MessageAttribute called ErrorDetail with the message of the error.

1.2.0
=====
* Support multiple subscribers to the same queue via the readers option on the subscribe method (or multiple calls to subscribe, but that would be super weird)

1.3.0
=====
* More flexible config - queues can be an array. This might make it harder to override in confit, but there are structures that can make that work so I will allow it, and it handles the simple case well.
* Added getQueueConfiguration method to client to make it easier to co-locate relevant configuration options such as the number of readers on a queue

1.3.1
=====
* Pull number of readers for subscriptions from queue config, if present

1.3.2
=====
* Allow correlationid to be set as an option on publish

1.3.4
=====
* Auto-create a logical queue entry (locally, not on SQS) for deadLetter queue property if it doesn't exist already

1.4.1
=====
* Fix MockSQSClient to read config properly (as regular config does)

1.7.0
====
* Make an access denied error stop the consumer, because it is fatal.

1.8.0
====
* Add assumed role check in the config.  If you add an assumedRole, on start we will check to see if the caller's identity Arn contains the assumedRole.  If not throw an error on start, to fail on startup.

1.9.0
====
* Support deflating a message. Deflated message will automatically be inflated before delivering the a consumer
