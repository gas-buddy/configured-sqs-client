1.0.0
=====
* Everything changes.

1.1.0
=====
* Returning an error with a property deadLetter set to true or the logical name of another queue will publish the original message with a MessageAttribute called ErrorDetail with the message of the error.
