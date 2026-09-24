package com.acme.model;

/** An invoice. */
public class Invoice {
    public static class Line {
        public long cents;
    }

    public long total() { return 0; }
}
