SELECT 'CREATE DATABASE laguillotina_test OWNER guillotina'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'laguillotina_test')\gexec
