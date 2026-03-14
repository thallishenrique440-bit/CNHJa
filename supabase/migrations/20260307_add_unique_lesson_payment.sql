-- Add unique constraint to prevent duplicate lesson payments
ALTER TABLE transactions
ADD CONSTRAINT unique_lesson_payment
UNIQUE (appointment_id, type);
