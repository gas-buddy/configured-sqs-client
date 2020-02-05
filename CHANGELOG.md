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